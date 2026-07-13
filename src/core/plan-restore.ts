import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isProviderName } from "../config/providers.ts";
import { BlockedError, ExecutionError } from "../errors.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import type { CollectionPaths, ProviderName } from "../types/index.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { scanArchive } from "./archive-reader.ts";
import { pruneLocalBackupsIfParentExists } from "./backup-retention.ts";
import {
  type ExecutionReceipt,
  type ExecutionReceiptAction,
  type ExecutionReceiptOutcome,
  executionReceiptEndpointRef,
  finishExecutionReceipt,
  startExecutionReceipt,
} from "./execution-receipt.ts";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  type InventoryEntry,
  inventoryFingerprint,
  overlayInventories,
  overlayInventory,
  symlinkInventoryEntry,
} from "./inventory.ts";
import {
  executeLocalTransaction,
  finalizeLocalTransaction,
  type LocalTransactionMemberInput,
  type LocalTransactionRootBinding,
  localTransactionRootsForPaths,
} from "./local-transaction.ts";
import {
  claudeMcpManagedEntry,
  managedStateVerificationFingerprint,
} from "./managed-state-verification.ts";
import {
  createMigrationPlan,
  deriveActionId,
  type EndpointRef,
  fingerprint,
  type MigrationActionInput,
  type MigrationPlan,
  type PlanDependency,
} from "./migration-plan.ts";
import { observeLocalRestoreTarget, type RestoreTargetObservation } from "./restore-observation.ts";
import {
  bytesSha256,
  deriveRestoreObservationQueries,
  type RestoreTransformInputs,
  transformRestoreInputs,
} from "./restore-transforms.ts";
import { readTransactionJournal } from "./transaction-journal.ts";

export interface PlanRestoreInput {
  readonly archivePath: string;
  readonly provider?: ProviderName;
  readonly context: RuntimeContext;
  readonly paths: CollectionPaths;
  readonly createdAt?: string;
}

export interface PlannedRestore {
  readonly plan: MigrationPlan;
}

type RestoreActionBinding =
  | { readonly kind: "transform-stage"; readonly config?: Uint8Array; readonly hooks?: Uint8Array }
  | { readonly kind: "write-mcp"; readonly bytes: Uint8Array }
  | {
      readonly kind: "overlay-group";
      readonly logicalGroup: string;
      readonly entries: readonly InventoryEntry[];
    }
  | { readonly kind: "symlink-view"; readonly entries: readonly InventoryEntry[] };

interface RestorePlanResources {
  readonly context: RuntimeContext;
  readonly providers: readonly ProviderName[];
  readonly queries: ReturnType<typeof deriveRestoreObservationQueries>;
  readonly archivePath: string;
  readonly paths: CollectionPaths;
  readonly transformed: RestoreTransformInputs;
  readonly observation: RestoreTargetObservation;
  readonly selectedInventory: readonly InventoryEntry[];
  readonly stagedIncoming: readonly InventoryEntry[];
  readonly stagedFinal: readonly InventoryEntry[];
  readonly archiveSha256: string;
  readonly actionBindings: ReadonlyMap<string, RestoreActionBinding>;
}

const resources = new WeakMap<PlannedRestore, RestorePlanResources>();
const captures = new Set(["claude/.mcp-config.json", "codex/config.toml", "codex/hooks.json"]);

export class RestoreTargetPlanError extends Error {}
export class RestoreTransformPlanError extends Error {}

function endpoint(domain: string, value: string): EndpointRef {
  return `endpoint_${createHash("sha256").update(`ccm:${domain}\0${value}`).digest("hex")}`;
}

function opaqueRef(kind: string, logical: string): string {
  return `restore-${kind}-${createHash("sha256").update(`ccm:restore:${kind}\0${logical}`).digest("hex")}`;
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && Buffer.from(left).equals(right);
}

function inventoryEntry(path: string, mode: number, bytes: Uint8Array): InventoryEntry {
  return {
    path,
    type: "file",
    mode: (mode & 0o111) === 0 ? 0o644 : 0o755,
    size: bytes.byteLength,
    sha256: bytesSha256(bytes),
  };
}

function restoreObservedInventory(
  observation: RestoreTargetObservation,
  includeClaudeMcp: boolean,
): readonly InventoryEntry[] {
  return canonicalInventory([
    ...observation.inventory,
    ...(includeClaudeMcp ? [claudeMcpManagedEntry(observation.claudeMcp.bytes)] : []),
  ]);
}

function restoreVerificationInventory(
  inventory: readonly InventoryEntry[],
  claudeMcp: Uint8Array | undefined,
  includeClaudeMcp: boolean,
): readonly InventoryEntry[] {
  return canonicalInventory([
    ...inventory.filter((entry) => entry.path !== "claude/.mcp-config.json"),
    ...(includeClaudeMcp ? [claudeMcpManagedEntry(claudeMcp)] : []),
  ]);
}

function verificationRoots(
  before: readonly InventoryEntry[],
  after: readonly InventoryEntry[],
): readonly string[] {
  return [
    ...new Set(
      [before, after].flatMap((inventory) =>
        groupManagedTopLevelEntries(inventory).map((group) => group.path),
      ),
    ),
  ].sort();
}

function selectedInventory(
  inventory: readonly InventoryEntry[],
  providers: readonly ProviderName[],
) {
  const selected = new Set(providers);
  return inventory.filter((entry) => {
    if (entry.path.startsWith("claude/")) return selected.has("claude");
    if (entry.path.startsWith("codex/")) return selected.has("codex");
    return entry.path.startsWith("shared/agents/");
  });
}

function replaceEntry(
  entries: readonly InventoryEntry[],
  replacement: InventoryEntry,
): InventoryEntry[] {
  return [...entries.filter((entry) => entry.path !== replacement.path), replacement];
}

function groupAction(
  group: { path: string; entries: readonly InventoryEntry[] },
  target: readonly InventoryEntry[],
): MigrationActionInput {
  const overlay = overlayInventories(
    target.filter((entry) => entry.path === group.path || entry.path.startsWith(`${group.path}/`)),
    group.entries,
  );
  const changed = overlay.some(
    (item) => item.disposition === "create" || item.disposition === "update",
  );
  const existed = overlay.some((item) => item.disposition !== "create");
  return {
    operation: "overlay",
    disposition: changed ? (existed ? "update" : "create") : "unchanged",
    phase: "commit",
    scope: group.path.startsWith("claude/")
      ? "claude"
      : group.path.startsWith("codex/")
        ? "codex"
        : "shared",
    sourceRef: opaqueRef("source", group.path),
    targetRef: opaqueRef("target", group.path),
    beforeFingerprint: inventoryFingerprint(
      target.filter(
        (entry) => entry.path === group.path || entry.path.startsWith(`${group.path}/`),
      ),
    ),
    afterFingerprint: inventoryFingerprint(overlay.map((item) => item.entry)),
    reversibility: "reversible",
    policyProvenance: ["no-delete-overlay.default"],
  };
}

export async function planRestore(input: PlanRestoreInput): Promise<PlannedRestore> {
  if (input.provider !== undefined && !isProviderName(input.provider)) {
    throw new Error(`Unknown provider: ${String(input.provider)}`);
  }
  const scan = await scanArchive(input.archivePath, { capture: captures });
  const available = scan.archive.providers.filter(isProviderName);
  const providers = input.provider
    ? available.filter((item) => item === input.provider)
    : available;
  if (providers.length === 0) {
    throw new Error(
      input.provider
        ? `Provider '${input.provider}' not found in archive`
        : "No providers in archive",
    );
  }
  const observedInventory = canonicalInventory(
    scan.observedFiles.map((file) => ({
      path: file.path,
      type: "file" as const,
      mode: (file.mode & 0o111) === 0 ? (0o644 as const) : (0o755 as const),
      size: file.size,
      sha256: file.sha256,
    })),
  );
  const incoming = canonicalInventory(selectedInventory(observedInventory, providers));
  const captured: RestoreTransformInputs = {
    claudeMcp: providers.includes("claude")
      ? scan.capturedFiles.get("claude/.mcp-config.json")
      : undefined,
    codexConfig: providers.includes("codex")
      ? scan.capturedFiles.get("codex/config.toml")
      : undefined,
    codexHooks: providers.includes("codex")
      ? scan.capturedFiles.get("codex/hooks.json")
      : undefined,
  };
  let queries: ReturnType<typeof deriveRestoreObservationQueries>;
  try {
    queries = deriveRestoreObservationQueries(captured);
  } catch (error) {
    throw new RestoreTransformPlanError(
      `Restore inputs are invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let observation: RestoreTargetObservation;
  try {
    observation = await observeLocalRestoreTarget({
      context: input.context,
      paths: input.paths,
      selectedProviders: providers,
      incoming,
      queries,
    });
  } catch (error) {
    throw new RestoreTargetPlanError(
      `Restore target is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let transformed: RestoreTransformInputs & { warnings: readonly string[] };
  try {
    transformed = await transformRestoreInputs(
      captured,
      observation.claudeMcp,
      observation.facts,
      input.paths,
    );
  } catch (error) {
    throw new RestoreTransformPlanError(
      `Restore inputs are invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let stagedIncoming = [...incoming];
  if (transformed.claudeMcp)
    stagedIncoming = replaceEntry(
      stagedIncoming,
      inventoryEntry("claude/.mcp-config.json", 0o644, transformed.claudeMcp),
    );
  if (transformed.codexConfig)
    stagedIncoming = replaceEntry(
      stagedIncoming,
      inventoryEntry("codex/config.toml", 0o644, transformed.codexConfig),
    );
  if (transformed.codexHooks)
    stagedIncoming = replaceEntry(
      stagedIncoming,
      inventoryEntry("codex/hooks.json", 0o644, transformed.codexHooks),
    );
  let staged = [...overlayInventory(observation.inventory, stagedIncoming)];
  const hasClaude = incoming.some((entry) => entry.path.startsWith("claude/"));
  const hasShared = incoming.some((entry) => entry.path.startsWith("shared/agents/"));
  if (providers.includes("claude") && hasClaude && hasShared) {
    for (const name of observation.facts.sharedSkillNames) {
      const prefix = `claude/skills/${name}`;
      staged = staged.filter(
        (entry) => entry.path !== prefix && !entry.path.startsWith(`${prefix}/`),
      );
      staged.push(symlinkInventoryEntry(prefix, `${input.paths.sharedSkillsDir}/${name}`));
    }
  }

  const actions: MigrationActionInput[] = [];
  if (transformed.codexConfig || transformed.codexHooks)
    actions.push({
      operation: "transform",
      disposition:
        sameBytes(transformed.codexConfig, captured.codexConfig) &&
        sameBytes(transformed.codexHooks, captured.codexHooks)
          ? "unchanged"
          : "update",
      phase: "materialize",
      scope: "codex",
      sourceRef: opaqueRef("source", "codex-transform-inputs"),
      targetRef: opaqueRef("target", "codex-transform-stage"),
      afterFingerprint: inventoryFingerprint(
        stagedIncoming.filter(
          (entry) => entry.path === "codex/config.toml" || entry.path === "codex/hooks.json",
        ),
      ),
      reversibility: "reversible",
      policyProvenance: ["host-adaptation.default", "trust-reset.default"],
    });
  if (transformed.claudeMcp)
    actions.push({
      operation: "merge-json",
      disposition: observation.claudeMcp.exists
        ? sameBytes(transformed.claudeMcp, observation.claudeMcp.bytes)
          ? "unchanged"
          : "merge"
        : "create",
      phase: "commit",
      scope: "claude",
      sourceRef: opaqueRef("source", "claude-mcp-archive-member"),
      targetRef: opaqueRef("target", "claude-mcp-config"),
      beforeFingerprint: observation.claudeMcp.fingerprint,
      afterFingerprint: fingerprint("restore-claude-mcp-output-v1", {
        sha256: bytesSha256(transformed.claudeMcp),
        size: transformed.claudeMcp.byteLength,
      }),
      reversibility: "reversible",
      policyProvenance: ["strict-json-merge.default"],
    });
  const materializeActions = actions.filter((action) => action.phase === "materialize");
  const overlayGroups = groupManagedTopLevelEntries(
    stagedIncoming.filter((entry) => entry.path !== "claude/.mcp-config.json"),
  );
  for (const scope of ["claude", "codex", "shared"] as const) {
    for (const group of overlayGroups.filter((item) =>
      scope === "shared" ? item.path.startsWith("shared/") : item.path.startsWith(`${scope}/`),
    )) {
      actions.push(groupAction(group, observation.inventory));
    }
  }
  let symlinkAction: MigrationActionInput | undefined;
  if (
    providers.includes("claude") &&
    hasClaude &&
    hasShared &&
    observation.facts.sharedSkillNames.length > 0
  ) {
    symlinkAction = {
      operation: "symlink",
      disposition:
        inventoryFingerprint(
          observation.inventory.filter((entry) => entry.path.startsWith("claude/skills/")),
        ) ===
        inventoryFingerprint(staged.filter((entry) => entry.path.startsWith("claude/skills/")))
          ? "unchanged"
          : "update",
      phase: "post-commit",
      scope: "claude",
      sourceRef: opaqueRef("source", "shared-skills-view"),
      targetRef: opaqueRef("target", "claude-shared-skills-view"),
      afterFingerprint: inventoryFingerprint(
        staged.filter((entry) => entry.path.startsWith("claude/skills/")),
      ),
      reversibility: "reversible",
      policyProvenance: ["shared-skill-view.default"],
    };
    actions.push(symlinkAction);
  }
  const dependencies: PlanDependency[] = [];
  for (const action of actions) {
    const id = deriveActionId(action);
    if (action.operation === "overlay") {
      for (const materialize of materializeActions.filter((item) => item.scope === action.scope)) {
        const dependency = deriveActionId(materialize);
        dependencies.push({
          id: `dep-${dependencies.length + 1}`,
          ownerActionId: id,
          dependsOnActionId: dependency,
          type: "data",
          required: true,
          status: "satisfied",
          resolution: "resolved",
        });
      }
    }
  }
  if (symlinkAction) {
    const ownerActionId = deriveActionId(symlinkAction);
    for (const action of actions.filter(
      (item) => item.phase === "commit" && (item.scope === "shared" || item.scope === "claude"),
    ))
      dependencies.push({
        id: `dep-${dependencies.length + 1}`,
        ownerActionId,
        dependsOnActionId: deriveActionId(action),
        type: "ordering",
        required: true,
        status: "satisfied",
        resolution: "resolved",
      });
  }
  const plan = createMigrationPlan({
    kind: "restore",
    providers,
    executionModel: "local-staged-overlay",
    sourceEndpointRef: endpoint("restore-source", scan.archive.archiveSha256),
    targetEndpointRef: endpoint("restore-target", observation.targetFingerprint),
    sourceFingerprint: fingerprint("restore-source-v1", {
      archiveSha256: scan.archive.archiveSha256,
      providers,
      inventory: inventoryFingerprint(incoming),
    }),
    targetFingerprint: observation.targetFingerprint,
    stagedPostFingerprint: inventoryFingerprint(staged),
    preconditions: [
      {
        id: "archive-provider-selection",
        required: true,
        status: "satisfied",
        reasonCode: "providers-available",
      },
      {
        id: "archive-input-shape",
        required: true,
        status: "satisfied",
        reasonCode: "managed-members-valid",
      },
      {
        id: "local-target-shape",
        required: true,
        status: "satisfied",
        reasonCode: "managed-target-valid",
      },
    ],
    actions,
    dependencies,
    warnings: [
      ...(scan.archive.format === "v1" ? [{ code: "legacy-v1-integrity-unavailable" }] : []),
      ...transformed.warnings.map((warning) => ({
        code: `transform-warning-${createHash("sha256").update(warning).digest("hex").slice(0, 16)}`,
      })),
    ],
    policies: [{ code: "deletion", valueCode: "none", provenance: "default" }],
    createdAt: input.createdAt ?? input.context.now().toISOString(),
  });
  const planned = Object.freeze({ plan });
  const actionBindings = new Map<string, RestoreActionBinding>();
  for (const action of actions) {
    const id = deriveActionId(action);
    if (action.operation === "transform") {
      actionBindings.set(id, {
        kind: "transform-stage",
        config: transformed.codexConfig && Buffer.from(transformed.codexConfig),
        hooks: transformed.codexHooks && Buffer.from(transformed.codexHooks),
      });
    } else if (action.operation === "merge-json") {
      actionBindings.set(id, {
        kind: "write-mcp",
        bytes: Buffer.from(transformed.claudeMcp as Uint8Array),
      });
    } else if (action.operation === "overlay") {
      const group = overlayGroups.find(
        (item) => opaqueRef("target", item.path) === action.targetRef,
      );
      if (!group) throw new Error("Missing restore overlay action binding");
      actionBindings.set(id, {
        kind: "overlay-group",
        logicalGroup: group.path,
        entries: canonicalInventory(group.entries).map((entry) => Object.freeze({ ...entry })),
      });
    } else if (action.operation === "symlink") {
      const intended = new Set(observation.facts.sharedSkillNames);
      actionBindings.set(id, {
        kind: "symlink-view",
        entries: canonicalInventory(
          staged.filter(
            (entry) =>
              entry.type === "symlink" &&
              entry.path.split("/").length === 3 &&
              entry.path.startsWith("claude/skills/") &&
              intended.has(entry.path.split("/")[2] as string),
          ),
        ).map((entry) => Object.freeze({ ...entry })),
      });
    }
  }
  resources.set(planned, {
    archivePath: input.archivePath,
    context: input.context,
    providers,
    queries,
    paths: { ...input.paths },
    transformed: {
      claudeMcp: transformed.claudeMcp && Buffer.from(transformed.claudeMcp),
      codexConfig: transformed.codexConfig && Buffer.from(transformed.codexConfig),
      codexHooks: transformed.codexHooks && Buffer.from(transformed.codexHooks),
    },
    observation,
    selectedInventory: canonicalInventory(incoming).map((entry) => Object.freeze({ ...entry })),
    stagedIncoming: canonicalInventory(stagedIncoming).map((entry) => Object.freeze({ ...entry })),
    stagedFinal: canonicalInventory(staged).map((entry) => Object.freeze({ ...entry })),
    archiveSha256: scan.archive.archiveSha256,
    actionBindings,
  });
  return planned;
}

export interface ExecutePlannedRestoreOptions {
  /** Test seam for proving the second target drift check. */
  readonly afterBackup?: () => Promise<void>;
  /** Test seam immediately after cloning a live transaction member. */
  readonly afterStageClone?: (stagePath: string, logicalBase: string) => Promise<void>;
  /** Test seam after the terminal journal is durable, before receipt publication. */
  readonly afterTransactionTerminal?: () => Promise<void>;
}

function sourceFingerprint(
  archiveSha256: string,
  providers: readonly ProviderName[],
  inventory: readonly InventoryEntry[],
) {
  return fingerprint("restore-source-v1", {
    archiveSha256,
    providers,
    inventory: inventoryFingerprint(inventory),
  });
}

async function assertTargetUnchanged(resource: RestorePlanResources): Promise<void> {
  const observed = await observeLocalRestoreTarget({
    context: resource.context,
    paths: resource.paths,
    selectedProviders: resource.providers,
    incoming: resource.selectedInventory,
    queries: resource.queries,
  });
  if (observed.targetFingerprint !== resource.observation.targetFingerprint)
    throw new BlockedError("Restore target changed after planning");
}

interface RestoreTransactionMember {
  readonly rootCode: string;
  readonly rootPath: string;
  readonly targetRef: string;
  readonly logicalBase: string;
  readonly overlays: InventoryEntry[];
  readonly symlinks: InventoryEntry[];
  mcpBytes?: Uint8Array;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSafeStageParent(stagePath: string, target: string): Promise<void> {
  if (target === stagePath) return;
  const root = await lstat(stagePath);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new BlockedError("Restore stage root is not a directory");
  const suffix = relative(stagePath, dirname(target));
  if (suffix === "") return;
  if (suffix === ".." || suffix.startsWith("../"))
    throw new BlockedError("Restore stage target escapes its transaction member");
  let current = stagePath;
  for (const segment of suffix.split("/")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new BlockedError("Restore stage has a non-directory ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new BlockedError("Restore stage ancestor changed during creation");
    }
  }
}

function restoreRoot(
  paths: CollectionPaths,
  logical: string,
): { code: string; path: string; relativePath: string; logicalRoot: string } {
  const parts = logical.split("/");
  if (parts[0] === "claude")
    return {
      code: "claude-home",
      path: paths.claudeDir,
      relativePath: parts.slice(1).join("/"),
      logicalRoot: "claude",
    };
  if (parts[0] === "codex")
    return {
      code: "codex-home",
      path: paths.codexDir,
      relativePath: parts.slice(1).join("/"),
      logicalRoot: "codex",
    };
  if (parts[0] === "shared" && parts[1] === "agents")
    return {
      code: "shared-agents",
      path: paths.sharedAgentsDir,
      relativePath: parts.slice(2).join("/"),
      logicalRoot: "shared/agents",
    };
  throw new BlockedError(`Unsupported restore path: ${logical}`);
}

async function buildRestoreTransactionMembers(
  resource: RestorePlanResources,
  changed: readonly RestoreActionBinding[],
  extraction: string,
  afterStageClone?: (stagePath: string, logicalBase: string) => Promise<void>,
): Promise<{ roots: LocalTransactionRootBinding[]; members: LocalTransactionMemberInput[] }> {
  const roots: LocalTransactionRootBinding[] = localTransactionRootsForPaths(resource.paths);
  const absentRoots = new Set<string>();
  for (const root of roots) if (!(await pathExists(root.path))) absentRoots.add(root.code);
  const specs = new Map<string, RestoreTransactionMember>();
  const memberFor = (logical: string): RestoreTransactionMember => {
    const root = restoreRoot(resource.paths, logical);
    const targetRef = absentRoots.has(root.code)
      ? "."
      : (root.relativePath.split("/")[0] as string);
    const logicalBase = targetRef === "." ? root.logicalRoot : `${root.logicalRoot}/${targetRef}`;
    const key = `${root.code}:${targetRef}`;
    let member = specs.get(key);
    if (!member) {
      member = {
        rootCode: root.code,
        rootPath: root.path,
        targetRef,
        logicalBase,
        overlays: [],
        symlinks: [],
      };
      specs.set(key, member);
    }
    return member;
  };
  for (const binding of changed) {
    if (binding.kind === "overlay-group") {
      const member = memberFor(binding.logicalGroup);
      member.overlays.push(...binding.entries);
    } else if (binding.kind === "symlink-view") {
      for (const entry of binding.entries) memberFor(entry.path).symlinks.push(entry);
    } else if (binding.kind === "write-mcp") {
      const key = "claude-mcp:.";
      specs.set(key, {
        rootCode: "claude-mcp",
        rootPath: resource.paths.claudeMcpConfigPath,
        targetRef: ".",
        logicalBase: "claude/.mcp-config.json",
        overlays: [],
        symlinks: [],
        mcpBytes: binding.bytes,
      });
    }
  }
  const members = [...specs.values()].map(
    (spec, index): LocalTransactionMemberInput => ({
      id: `restore-member-${index + 1}`,
      rootCode: spec.rootCode,
      targetRef: spec.targetRef,
      materialize: async (stagePath) => {
        if (spec.mcpBytes) {
          await writeFile(stagePath, spec.mcpBytes, { mode: 0o600, flag: "wx" });
          return;
        }
        const live = spec.targetRef === "." ? spec.rootPath : join(spec.rootPath, spec.targetRef);
        if (await pathExists(live)) await cp(live, stagePath, { recursive: true, force: true });
        else {
          const needsDirectory =
            spec.targetRef === "." ||
            [...spec.overlays, ...spec.symlinks].some((entry) => entry.path !== spec.logicalBase);
          if (needsDirectory) await mkdir(stagePath, { recursive: true });
        }
        await afterStageClone?.(stagePath, spec.logicalBase);
        for (const entry of spec.overlays) {
          const suffix = relative(spec.logicalBase, entry.path);
          const target = suffix === "" ? stagePath : join(stagePath, suffix);
          await ensureSafeStageParent(stagePath, target);
          await rm(target, { recursive: true, force: true });
          await cp(join(extraction, entry.path), target, { recursive: true, force: true });
          await chmod(target, entry.mode);
        }
        for (const entry of spec.symlinks) {
          const suffix = relative(spec.logicalBase, entry.path);
          const target = suffix === "" ? stagePath : join(stagePath, suffix);
          await ensureSafeStageParent(stagePath, target);
          await rm(target, { recursive: true, force: true });
          await symlink(
            join(resource.paths.sharedSkillsDir, entry.path.split("/").at(-1) as string),
            target,
          );
        }
      },
    }),
  );
  return { roots, members };
}

export async function executePlannedRestore(
  planned: PlannedRestore,
  options: ExecutePlannedRestoreOptions = {},
): Promise<string | undefined> {
  const resource = resources.get(planned);
  if (!resource) throw new BlockedError("Restore plan is forged or no longer executable");
  if (planned.plan.status === "blocked")
    throw new BlockedError("Blocked restore plan cannot execute");
  if (planned.plan.status === "noop") {
    resources.delete(planned);
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), "ccm-restore-"));
  const extraction = join(temp, "archive");
  const unregisterInterruptCleanup = registerInterruptCleanup(() =>
    rm(temp, { recursive: true, force: true }),
  );
  let mutationStarted = false;
  let receipt: ExecutionReceipt | undefined;
  let transactionId: string | undefined;
  let transactionCommitted = false;
  let transaction:
    | { roots: LocalTransactionRootBinding[]; members: LocalTransactionMemberInput[] }
    | undefined;
  const includeClaudeMcp =
    resource.selectedInventory.some((entry) => entry.path === "claude/.mcp-config.json") ||
    resource.transformed.claudeMcp !== undefined;
  try {
    const scan = await scanArchive(resource.archivePath, { extractTo: extraction });
    const observedInventory = canonicalInventory(
      scan.observedFiles.map((file) => ({
        path: file.path,
        type: "file" as const,
        mode: (file.mode & 0o111) === 0 ? (0o644 as const) : (0o755 as const),
        size: file.size,
        sha256: file.sha256,
      })),
    );
    const selected = canonicalInventory(selectedInventory(observedInventory, resource.providers));
    if (
      scan.archive.archiveSha256 !== resource.archiveSha256 ||
      sourceFingerprint(scan.archive.archiveSha256, resource.providers, selected) !==
        planned.plan.sourceFingerprint
    )
      throw new BlockedError("Restore archive changed after planning");

    if (resource.transformed.codexConfig)
      await writeFile(join(extraction, "codex/config.toml"), resource.transformed.codexConfig);
    if (resource.transformed.codexHooks)
      await writeFile(join(extraction, "codex/hooks.json"), resource.transformed.codexHooks);
    const stagedScan = await Promise.all(
      resource.stagedIncoming.map(async (entry) => {
        const bytes =
          entry.path === "claude/.mcp-config.json" && resource.transformed.claudeMcp
            ? resource.transformed.claudeMcp
            : await readFile(join(extraction, entry.path));
        return inventoryEntry(entry.path, entry.mode, bytes);
      }),
    );
    if (inventoryFingerprint(stagedScan) !== inventoryFingerprint(resource.stagedIncoming))
      throw new Error("Staged restore inventory does not match plan");
    if (inventoryFingerprint(resource.stagedFinal) !== planned.plan.stagedPostFingerprint)
      throw new Error("Sealed staged restore fingerprint does not match plan");

    const actionIndexes = new Map(planned.plan.actions.map((action, index) => [action.id, index]));
    for (const action of planned.plan.actions)
      if (!resource.actionBindings.has(action.id))
        throw new Error(`Missing restore action binding: ${action.id}`);
    for (const dependency of planned.plan.dependencies)
      if (
        dependency.required &&
        (actionIndexes.get(dependency.dependsOnActionId) ?? Number.MAX_SAFE_INTEGER) >=
          (actionIndexes.get(dependency.ownerActionId) ?? -1)
      )
        throw new Error(`Restore action dependency is out of order: ${dependency.id}`);

    const consumed = new Set<string>();
    const changedBindings: RestoreActionBinding[] = [];
    for (const action of planned.plan.actions) {
      for (const dependency of planned.plan.dependencies.filter(
        (item) => item.ownerActionId === action.id && item.required,
      ))
        if (!consumed.has(dependency.dependsOnActionId))
          throw new Error(`Restore action dependency was not consumed: ${dependency.id}`);
      const binding = resource.actionBindings.get(action.id);
      if (!binding) throw new Error(`Missing restore action binding: ${action.id}`);
      consumed.add(action.id);
      if (action.disposition === "unchanged" || binding.kind === "transform-stage") continue;
      changedBindings.push(binding);
    }
    if (
      consumed.size !== resource.actionBindings.size ||
      consumed.size !== planned.plan.actions.length
    )
      throw new Error("Restore action bindings were not consumed exactly once");
    await assertTargetUnchanged(resource);
    const builtTransaction = await buildRestoreTransactionMembers(
      resource,
      changedBindings,
      extraction,
      options.afterStageClone,
    );
    transaction = builtTransaction;
    const beforeInventory = restoreObservedInventory(resource.observation, includeClaudeMcp);
    const plannedVerificationInventory = restoreVerificationInventory(
      resource.stagedFinal,
      resource.transformed.claudeMcp,
      includeClaudeMcp,
    );
    receipt = await startExecutionReceipt(resource.context, planned.plan, {
      verification: {
        mode: "local",
        endpointRef: executionReceiptEndpointRef("local", resource.context.home),
        inventoryRoots: verificationRoots(beforeInventory, plannedVerificationInventory),
        claudeMcp: includeClaudeMcp,
        codexPluginList: false,
        beforeFingerprint: managedStateVerificationFingerprint(beforeInventory),
        plannedFingerprint: managedStateVerificationFingerprint(plannedVerificationInventory),
      },
    });
    resources.delete(planned);
    mutationStarted = true;
    const journal = await executeLocalTransaction({
      context: resource.context,
      planId: planned.plan.id,
      receiptId: receipt.id,
      roots: builtTransaction.roots,
      members: builtTransaction.members,
      deferTerminalFinalization: true,
      afterBoundary: async (boundary, current) => {
        if (boundary === "journal:planning") transactionId = current.id;
      },
      beforeCommit: async () => {
        await options.afterBackup?.();
        await assertTargetUnchanged(resource);
      },
      verify: async () => {
        const actual = await observeLocalRestoreTarget({
          context: resource.context,
          paths: resource.paths,
          selectedProviders: resource.providers,
          incoming: resource.selectedInventory,
          queries: resource.queries,
        });
        const actualFinal = [...actual.inventory];
        if (resource.transformed.claudeMcp && actual.claudeMcp.bytes)
          actualFinal.push(
            inventoryEntry("claude/.mcp-config.json", 0o644, actual.claudeMcp.bytes),
          );
        if (inventoryFingerprint(actualFinal) !== planned.plan.stagedPostFingerprint)
          throw new Error("Restored target does not match planned post-state");
      },
    });
    transactionId = journal.id;
    transactionCommitted = true;
    await options.afterTransactionTerminal?.();
    await finishExecutionReceipt(resource.context, receipt, {
      outcome: "succeeded",
      finishedAt: resource.context.now(),
      actions: receiptActions(receipt, "succeeded"),
      observedPostFingerprint: planned.plan.stagedPostFingerprint,
      observedManagedStateFingerprint: managedStateVerificationFingerprint(
        plannedVerificationInventory,
      ),
      transactionId,
    });
    await finalizeLocalTransaction({
      context: resource.context,
      transactionId,
      roots: builtTransaction.roots,
    });
    try {
      for (const root of new Set(
        builtTransaction.members.map((member) => {
          const binding = builtTransaction.roots.find((item) => item.code === member.rootCode);
          if (!binding) throw new Error(`Missing transaction root: ${member.rootCode}`);
          return binding.path;
        }),
      ))
        await pruneLocalBackupsIfParentExists(root);
    } catch (retentionError) {
      throw new ExecutionError("Restore committed but backup retention cleanup failed", {
        cause: retentionError,
      });
    }
    return receipt.id;
  } catch (error) {
    if (transactionCommitted) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError(
        "Restore committed but receipt or transaction finalization is pending",
        {
          cause: error,
        },
      );
    }
    if (receipt) {
      let outcome: ExecutionReceiptOutcome = "failed";
      const terminalTransactionId = transactionId;
      let observedPostFingerprint: string | undefined;
      let observedManagedStateFingerprint: string | undefined;
      try {
        const observed = await observeLocalRestoreTarget({
          context: resource.context,
          paths: resource.paths,
          selectedProviders: resource.providers,
          incoming: resource.selectedInventory,
          queries: resource.queries,
        });
        observedPostFingerprint = observed.targetFingerprint;
        observedManagedStateFingerprint = managedStateVerificationFingerprint(
          restoreObservedInventory(observed, includeClaudeMcp),
        );
        if (transactionId && observed.targetFingerprint === planned.plan.targetFingerprint)
          outcome = "rolled_back";
      } catch {
        // The original execution error remains primary when observation is unavailable.
      }
      let terminalState: "rolled_back" | "recovery_required" | undefined;
      if (transactionId) {
        try {
          const pending = await readTransactionJournal(resource.context, transactionId);
          if (pending.state === "recovery_required") terminalState = "recovery_required";
          else if (pending.state === "rolled_back") terminalState = "rolled_back";
        } catch (journalError) {
          throw new ExecutionError("Restore failed and transaction state could not be verified", {
            cause: new AggregateError([error, journalError]),
          });
        }
      }
      if (terminalState === "recovery_required") outcome = "recovery_required";
      try {
        await finishExecutionReceipt(resource.context, receipt, {
          outcome,
          finishedAt: resource.context.now(),
          actions: receiptActions(receipt, "failed"),
          ...(observedPostFingerprint === undefined ? {} : { observedPostFingerprint }),
          ...(observedManagedStateFingerprint === undefined
            ? {}
            : { observedManagedStateFingerprint }),
          ...(terminalTransactionId === undefined ? {} : { transactionId: terminalTransactionId }),
        });
      } catch (receiptError) {
        throw new ExecutionError("Restore failed and receipt finalization also failed", {
          cause: new AggregateError([error, receiptError]),
        });
      }
      if (terminalState === "rolled_back" && transactionId && transaction)
        try {
          await finalizeLocalTransaction({
            context: resource.context,
            transactionId,
            roots: transaction.roots,
          });
        } catch (finalizationError) {
          throw new ExecutionError(
            "Restore rolled back and receipt was published, but transaction finalization is pending",
            { cause: new AggregateError([error, finalizationError]) },
          );
        }
    }
    if (error instanceof BlockedError || error instanceof ExecutionError) throw error;
    if (!mutationStarted)
      throw new BlockedError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    throw new ExecutionError(
      `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
    unregisterInterruptCleanup();
  }
}

function receiptActions(
  receipt: ExecutionReceipt,
  outcome: "succeeded" | "failed",
): ExecutionReceiptAction[] {
  return receipt.actions.map((action) => ({
    ...action,
    outcome:
      action.outcome === "skipped" ? "skipped" : outcome === "succeeded" ? "succeeded" : "failed",
  }));
}
