import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isProviderName } from "../config/providers.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import type { CollectionPaths, ProviderName } from "../types/index.ts";
import { BlockedError, ExecutionError } from "../errors.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { scanArchive } from "./archive-reader.ts";
import { pruneLocalBackupsIfParentExists } from "./backup-retention.ts";
import { backupLocalDirectoryIfExists } from "./restore.ts";
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
  let observation: RestoreTargetObservation;
  try {
    observation = await observeLocalRestoreTarget({
      context: input.context,
      paths: input.paths,
      selectedProviders: providers,
      incoming,
      queries: deriveRestoreObservationQueries(captured),
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
      `Restore transform input is invalid: ${error instanceof Error ? error.message : String(error)}`,
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
    queries: deriveRestoreObservationQueries(captured),
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

function livePath(paths: CollectionPaths, logical: string): string {
  const parts = logical.split("/");
  if (parts[0] === "claude") return join(paths.claudeDir, ...parts.slice(1));
  if (parts[0] === "codex") return join(paths.codexDir, ...parts.slice(1));
  if (parts[0] === "shared" && parts[1] === "agents")
    return join(paths.sharedAgentsDir, ...parts.slice(2));
  throw new Error(`Unsupported restore path: ${logical}`);
}

async function atomicWriteNoFollow(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const stat = await import("node:fs/promises").then(({ lstat }) => lstat(path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Restore target must be a regular non-symlink file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1)}.ccm-${crypto.randomUUID()}.tmp`,
  );
  let committed = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true });
  }
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
    throw new Error("Restore target changed after planning");
}

export async function executePlannedRestore(
  planned: PlannedRestore,
  options: ExecutePlannedRestoreOptions = {},
): Promise<void> {
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
  const ownedBackups: string[] = [];
  let mutationStarted = false;
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

    await assertTargetUnchanged(resource);
    const changed = planned.plan.actions.filter(
      (action) => action.phase !== "materialize" && action.disposition !== "unchanged",
    );
    const managed = new Map<string, Set<string>>();
    for (const action of changed) {
      const binding = resource.actionBindings.get(action.id);
      if (binding?.kind === "symlink-view") {
        const entries = managed.get(resource.paths.claudeDir) ?? new Set<string>();
        for (const entry of binding.entries) entries.add(entry.path.slice("claude/".length));
        managed.set(resource.paths.claudeDir, entries);
        continue;
      }
      if (binding?.kind !== "overlay-group") continue;
      const logical = binding.logicalGroup.split("/");
      const root =
        logical[0] === "claude"
          ? resource.paths.claudeDir
          : logical[0] === "codex"
            ? resource.paths.codexDir
            : resource.paths.sharedAgentsDir;
      const relative =
        logical[0] === "shared" ? logical.slice(2).join("/") : logical.slice(1).join("/");
      const entries = managed.get(root) ?? new Set<string>();
      entries.add(relative);
      managed.set(root, entries);
    }
    for (const [root, entries] of managed) {
      const backup = await backupLocalDirectoryIfExists(root, [...entries], { prune: false });
      if (backup) ownedBackups.push(backup);
    }
    if (changed.some((action) => action.operation === "merge-json")) {
      const backup = await backupLocalDirectoryIfExists(
        resource.paths.claudeMcpConfigPath,
        undefined,
        { prune: false },
      );
      if (backup) ownedBackups.push(backup);
    }
    await options.afterBackup?.();
    try {
      await assertTargetUnchanged(resource);
    } catch (error) {
      for (const backup of ownedBackups) await rm(backup, { recursive: true, force: true });
      throw error;
    }

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
      if (!mutationStarted) {
        resources.delete(planned);
        mutationStarted = true;
      }
      if (binding.kind === "write-mcp") {
        await atomicWriteNoFollow(resource.paths.claudeMcpConfigPath, binding.bytes);
      } else if (binding.kind === "overlay-group") {
        for (const entry of binding.entries) {
          const source = join(extraction, entry.path);
          const target = livePath(resource.paths, entry.path);
          await mkdir(dirname(target), { recursive: true });
          await cp(source, target, { recursive: true, force: true });
          await chmod(target, entry.mode);
        }
      } else if (binding.kind === "symlink-view") {
        for (const entry of binding.entries) {
          const target = livePath(resource.paths, entry.path);
          await rm(target, { recursive: true, force: true });
          await mkdir(dirname(target), { recursive: true });
          const name = entry.path.split("/").at(-1) as string;
          await symlink(join(resource.paths.sharedSkillsDir, name), target);
        }
      }
    }
    if (
      consumed.size !== resource.actionBindings.size ||
      consumed.size !== planned.plan.actions.length
    )
      throw new Error("Restore action bindings were not consumed exactly once");
    const actual = await observeLocalRestoreTarget({
      context: resource.context,
      paths: resource.paths,
      selectedProviders: resource.providers,
      incoming: resource.selectedInventory,
      queries: resource.queries,
    });
    const actualFinal = [...actual.inventory];
    if (resource.transformed.claudeMcp && actual.claudeMcp.bytes)
      actualFinal.push(inventoryEntry("claude/.mcp-config.json", 0o644, actual.claudeMcp.bytes));
    if (inventoryFingerprint(actualFinal) !== planned.plan.stagedPostFingerprint)
      throw new Error("Restored target does not match planned post-state");
    for (const root of managed.keys()) await pruneLocalBackupsIfParentExists(root);
    if (changed.some((action) => action.operation === "merge-json"))
      await pruneLocalBackupsIfParentExists(resource.paths.claudeMcpConfigPath);
  } catch (error) {
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
