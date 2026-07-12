import { createHash } from "node:crypto";
import { isProviderName } from "../config/providers.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import type { CollectionPaths, ProviderName } from "../types/index.ts";
import { scanArchive } from "./archive-reader.ts";
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

interface RestorePlanResources {
  readonly archivePath: string;
  readonly paths: CollectionPaths;
  readonly captured: RestoreTransformInputs;
  readonly observation: RestoreTargetObservation;
  readonly steps: readonly string[];
}

const resources = new WeakMap<PlannedRestore, RestorePlanResources>();
const captures = new Set(["claude/.mcp-config.json", "codex/config.toml", "codex/hooks.json"]);

function endpoint(domain: string, value: string): EndpointRef {
  return `endpoint_${createHash("sha256").update(`ccm:${domain}\0${value}`).digest("hex")}`;
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
    sourceRef: `archive-${group.path.replaceAll("/", "-")}`,
    targetRef: `local-${group.path.replaceAll("/", "-")}`,
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
  const observation = await observeLocalRestoreTarget({
    context: input.context,
    paths: input.paths,
    selectedProviders: providers,
    incoming,
    queries: deriveRestoreObservationQueries(captured),
  });
  const transformed = await transformRestoreInputs(
    captured,
    observation.claudeMcp,
    observation.facts,
    input.paths,
  );
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
      disposition: "update",
      phase: "materialize",
      scope: "codex",
      sourceRef: "captured-codex-inputs",
      targetRef: "staged-codex-inputs",
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
      disposition: observation.claudeMcp.exists ? "merge" : "create",
      phase: "materialize",
      scope: "claude",
      sourceRef: "captured-claude-mcp",
      targetRef: "staged-claude-mcp",
      beforeFingerprint: observation.claudeMcp.fingerprint,
      afterFingerprint: fingerprint("restore-claude-mcp-output-v1", {
        sha256: bytesSha256(transformed.claudeMcp),
        size: transformed.claudeMcp.byteLength,
      }),
      reversibility: "reversible",
      policyProvenance: ["strict-json-merge.default"],
    });
  const materializeIds = actions.map(deriveActionId);
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
      disposition: "update",
      phase: "post-commit",
      scope: "claude",
      sourceRef: "shared-skills-view",
      targetRef: "claude-shared-skills-view",
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
    if (action.phase === "commit") {
      for (const dependency of materializeIds.filter((candidate) => candidate !== id))
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
    sourceFingerprint: inventoryFingerprint(incoming),
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
  resources.set(planned, {
    archivePath: input.archivePath,
    paths: { ...input.paths },
    captured,
    observation,
    steps: actions.map((action) => action.targetRef),
  });
  return planned;
}
