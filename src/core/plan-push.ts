import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { ExecutionError } from "../errors.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import type { CodexPluginPolicy, FileEntry, ProviderName } from "../types/index.ts";
import { projectCodexMarketplaceAvailability } from "./codex-marketplace-projection.ts";
import {
  type ExecutionReceipt,
  type ExecutionReceiptAction,
  type ExecutionReceiptOutcome,
  executionReceiptEndpointRef,
  finishExecutionReceipt,
  ReceiptPublicationAmbiguousError,
  reconcileExecutionReceiptPublication,
  startExecutionReceipt,
} from "./execution-receipt.ts";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  type InventoryEntry,
  inventoryFingerprint,
  inventoryFromFileEntries,
  overlayInventories,
  overlayInventory,
  symlinkInventoryEntry,
} from "./inventory.ts";
import {
  claudeMcpManagedEntry,
  managedStateVerificationFingerprint,
} from "./managed-state-verification.ts";
import {
  createMigrationPlan,
  deriveActionId,
  type EndpointRef,
  fingerprint,
  type MigrationAction,
  type MigrationActionInput,
  type MigrationPlan,
  type PlanDependency,
  type PlanFingerprint,
} from "./migration-plan.ts";
import {
  type PushObservationQueries,
  type PushTargetObservation,
  pushStateFingerprint,
} from "./push-observation.ts";
import {
  type PreparedPushObservationRequest,
  preparePushObservationRequest,
  pushObservationRequestIdentity,
} from "./push-observation-request.ts";
import {
  applyResolvedCodexProfile,
  type ResolvedPushProfile,
  verifyPushProfileAssets,
} from "./push-profile.ts";
import {
  type SealedPushSourceBindings,
  sealPushSourceBindings,
  stagePushArchive,
} from "./push-staging.ts";
import { type PushTransformInputs, transformPushInputs } from "./push-transforms.ts";

export interface PlanPushInput {
  readonly files: readonly FileEntry[];
  readonly host: string;
  readonly providers: readonly ProviderName[];
  readonly policyOverrides?: Readonly<Record<string, CodexPluginPolicy>>;
  readonly configuredPolicyIds?: readonly string[];
  readonly profile?: ResolvedPushProfile;
  readonly observation: PushTargetObservation;
  readonly preparedRequest: PreparedPushObservationRequest;
  readonly createdAt?: string;
  /** Deterministic race seam for tests; never represented in the public plan. */
  readonly afterDecisionCaptureTestHook?: () => Promise<void>;
}

export interface PlannedPush {
  readonly plan: MigrationPlan;
}

interface PushPlanResources {
  readonly files: readonly FileEntry[];
  readonly sourceInventory: readonly InventoryEntry[];
  readonly stagedIncoming: readonly InventoryEntry[];
  readonly actionBindings: ReadonlyMap<string, PushActionBinding>;
  readonly beforeRequest: PushExecutionObservationRequest;
  readonly finalRequest: PushExecutionObservationRequest;
  readonly filesystemPostFingerprint: PlanFingerprint;
  readonly verificationPostFingerprint: PlanFingerprint;
  readonly verificationClaudeMcp: boolean;
  readonly verificationCodexPluginList: boolean;
  readonly sources: SealedPushSourceBindings;
  readonly transformedBytes: ReadonlyMap<string, Uint8Array>;
  readonly decisionFiles: readonly FileEntry[];
  readonly decisionHashes: ReadonlyMap<string, string>;
  readonly profile?: ResolvedPushProfile;
}

export interface PushExecutionObservationRequest {
  readonly host: string;
  readonly inventoryRoots: readonly string[];
  readonly queries: PushObservationQueries;
  readonly requestIdentity: PlanFingerprint;
}

export type PushActionBinding =
  | {
      readonly kind: "materialize-codex";
      readonly config?: Uint8Array;
      readonly hooks?: Uint8Array;
    }
  | { readonly kind: "materialize-claude-mcp"; readonly bytes: Uint8Array }
  | { readonly kind: "write-claude-mcp"; readonly bytes: Uint8Array }
  | { readonly kind: "overlay-group"; readonly logicalGroup: string }
  | { readonly kind: "symlink-view"; readonly names: readonly string[] }
  | { readonly kind: "plugin-add"; readonly pluginId: string; readonly codexCommand: string };

function pushVerificationFingerprint(
  observation: PushTargetObservation,
  options: { readonly claudeMcp: boolean; readonly codexPluginList: boolean },
): PlanFingerprint {
  const mcp = options.claudeMcp ? observation.facts.captures.get("claude-mcp") : undefined;
  const pluginList = options.codexPluginList ? observation.facts.codexPluginList : undefined;
  if (pluginList !== undefined && pluginList.status !== "ok")
    throw new ExecutionError("Managed Codex plugin state could not be observed");
  return managedStateVerificationFingerprint(
    canonicalInventory([
      ...observation.inventory,
      ...(options.claudeMcp ? [claudeMcpManagedEntry(mcp ?? undefined)] : []),
    ]),
    pluginList,
  );
}

export interface PushExecutionAdapter {
  observe(
    request: PushExecutionObservationRequest,
    options?: { readonly mutationStarted?: boolean },
  ): Promise<PushTargetObservation>;
  prepare(input: {
    readonly archivePath: string;
    readonly archiveSha256: string;
    readonly archiveSize: number;
    readonly treePath?: string;
    readonly snapshotId?: string;
    readonly stagedInventory: readonly InventoryEntry[];
    readonly observationRequest: PushExecutionObservationRequest;
    readonly observation: PushTargetObservation;
    readonly actions: readonly {
      readonly action: MigrationAction;
      readonly binding: PushActionBinding;
    }[];
  }): Promise<PushExecutionSession>;
  transportMetrics?(): {
    readonly transferredBytes: number | null;
    readonly reusedBytes: number | null;
  };
}
export interface PushExecutionSession {
  apply(action: MigrationAction, binding: PushActionBinding): Promise<void>;
  commit(): Promise<void>;
  applyEffect(action: MigrationAction, binding: PushActionBinding): Promise<void>;
  acknowledgeFailedEffects(): Promise<void>;
  abort(): Promise<void>;
  verifyCommit(): Promise<void>;
  verifyRollback(): Promise<void>;
  isCommitted(): boolean;
  cleanup(): Promise<void>;
}

const resources = new WeakMap<PlannedPush, PushPlanResources>();

const endpoint = (domain: string, value: string): EndpointRef =>
  `endpoint_${createHash("sha256").update(`ccm:${domain}\0${value}`).digest("hex")}`;

const opaqueRef = (kind: string, logical: string): string =>
  `push-${kind}-${createHash("sha256").update(`ccm:push:${kind}\0${logical}`).digest("hex")}`;

const warningCode = (warning: string) =>
  `transform-warning-${createHash("sha256").update(warning).digest("hex").slice(0, 16)}`;

function transformInputs(bytes: ReadonlyMap<string, Uint8Array>): PushTransformInputs {
  return {
    claudeMcp: bytes.get("claude/.mcp-config.json"),
    codexConfig: bytes.get("codex/config.toml"),
    codexHooks: bytes.get("codex/hooks.json"),
  };
}

function inventoryEntry(path: string, previous: InventoryEntry, bytes: Uint8Array): InventoryEntry {
  return {
    path,
    type: "file",
    mode: previous.mode,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function replaceTransformed(
  incoming: readonly InventoryEntry[],
  path: string,
  bytes: Uint8Array | undefined,
): readonly InventoryEntry[] {
  if (!bytes) return incoming;
  const previous = incoming.find((entry) => entry.path === path);
  if (!previous) throw new Error(`Missing inventory entry for transformed push input: ${path}`);
  return canonicalInventory([
    ...incoming.filter((entry) => entry.path !== path),
    inventoryEntry(path, previous, bytes),
  ]);
}

function groupAction(
  group: { readonly path: string; readonly entries: readonly InventoryEntry[] },
  target: readonly InventoryEntry[],
  profileEffects?: ReadonlyMap<string, string>,
): MigrationActionInput {
  const before = target.filter(
    (entry) => entry.path === group.path || entry.path.startsWith(`${group.path}/`),
  );
  const overlay = overlayInventories(before, group.entries);
  const changed = overlay.some(
    (item) => item.disposition === "create" || item.disposition === "update",
  );
  return {
    operation: "overlay",
    disposition: changed ? (before.length === 0 ? "create" : "update") : "unchanged",
    phase: "commit",
    scope: group.path.startsWith("claude/")
      ? "claude"
      : group.path.startsWith("codex/")
        ? "codex"
        : "shared",
    sourceRef: opaqueRef("source", group.path),
    targetRef: opaqueRef("target", group.path),
    beforeFingerprint: inventoryFingerprint(before),
    afterFingerprint: inventoryFingerprint(overlay.map((item) => item.entry)),
    reversibility: "reversible",
    policyProvenance: [
      "no-delete-overlay.default",
      ...new Set(
        group.entries
          .map((entry) => profileEffects?.get(entry.path))
          .filter((code): code is string => code !== undefined),
      ),
    ],
  };
}

export async function planPush(input: PlanPushInput): Promise<PlannedPush> {
  if (input.profile && input.profile.host !== input.host)
    throw new Error("Push profile host does not match the planned target");
  const recomputedRequest = await preparePushObservationRequest({
    host: input.host,
    files: input.files,
    providers: input.providers,
    policyOverrides: input.policyOverrides,
  });
  if (
    recomputedRequest.requestIdentity !== input.preparedRequest.requestIdentity ||
    input.observation.requestIdentity !== input.preparedRequest.requestIdentity ||
    input.preparedRequest.requestIdentity !== pushObservationRequestIdentity(input.preparedRequest)
  )
    throw new Error("Push observation does not match the prepared request");
  if (input.preparedRequest.host !== input.host)
    throw new Error("Prepared push observation host does not match");
  const providers = [...new Set(input.providers)].sort();
  if (providers.length === 0) throw new Error("Push requires at least one provider");
  if (providers.length !== input.providers.length) throw new Error("duplicate provider");
  const selected = new Set(providers);
  const files = [...input.files];
  for (const file of files) {
    const valid = file.relativePath.startsWith("claude/")
      ? selected.has("claude")
      : file.relativePath.startsWith("codex/")
        ? selected.has("codex")
        : file.relativePath.startsWith("shared/agents/");
    if (!valid) throw new Error(`Push input is outside provider selection: ${file.relativePath}`);
  }
  const decisionBytes = new Map<string, Uint8Array>();
  const decisionModes = new Map<string, 0o644 | 0o755>();
  const decisionFiles: FileEntry[] = [];
  for (const file of files) {
    const isDecisionInput =
      ["claude/.mcp-config.json", "codex/config.toml", "codex/hooks.json"].includes(
        file.relativePath,
      ) || /\/(?:api_)?marketplace\.json$/.test(file.relativePath);
    if (!isDecisionInput) continue;
    const bytes =
      file.mcpServersOnly === undefined
        ? await readFile(file.sourcePath)
        : Buffer.from(file.mcpServersOnly);
    if (bytes.byteLength > 4 * 1024 * 1024)
      throw new Error(`Push decision input exceeds size limit: ${file.relativePath}`);
    const mode =
      file.mcpServersOnly === undefined && ((await lstat(file.sourcePath)).mode & 0o111) !== 0
        ? 0o755
        : 0o644;
    decisionBytes.set(file.relativePath, bytes);
    decisionModes.set(file.relativePath, mode);
    decisionFiles.push(Object.freeze({ ...file }));
  }
  await input.afterDecisionCaptureTestHook?.();
  const incoming = await inventoryFromFileEntries(files);
  for (const [path, bytes] of decisionBytes) {
    const entry = incoming.find((item) => item.path === path);
    if (
      !entry ||
      entry.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
      entry.mode !== decisionModes.get(path)
    )
      throw new Error(`Push decision input changed while planning: ${path}`);
  }
  if (input.observation.inventory.some((entry) => entry.path === "claude/.mcp-config.json"))
    throw new Error("Push observation includes the logical Claude MCP archive member");
  const captures = transformInputs(decisionBytes);
  const manifests: Array<{ path: string; content: string }> = [];
  const decisionHashes = new Map<string, string>();
  let invalidManifestLocation = false;
  for (const file of files) {
    const bytes = decisionBytes.get(file.relativePath);
    if (!bytes) continue;
    decisionHashes.set(file.relativePath, createHash("sha256").update(bytes).digest("hex"));
    if (!/\/(?:api_)?marketplace\.json$/.test(file.relativePath)) continue;
    let expectedName: string | undefined;
    const local = /^codex\/\.ccm\/marketplaces\/([^/]+)\//.exec(file.relativePath);
    if (local?.[1]) expectedName = local[1];
    else if (file.relativePath === "codex/.tmp/plugins/.agents/plugins/marketplace.json")
      expectedName = "openai-curated";
    else if (file.relativePath === "codex/.tmp/plugins/.agents/plugins/api_marketplace.json")
      expectedName = "openai-api-curated";
    else invalidManifestLocation = true;
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { name?: unknown };
      if (parsed.name !== expectedName) invalidManifestLocation = true;
    } catch {
      // Strict projector reports malformed JSON.
    }
    manifests.push({ path: file.relativePath, content: Buffer.from(bytes).toString("utf8") });
  }
  const projected = projectCodexMarketplaceAvailability(
    [...input.observation.facts.codexPluginList.available].filter(
      (id) =>
        !(input.observation.facts.codexPluginList.installed as readonly string[]).includes(id),
    ),
    manifests,
  );
  const marketplaceProjection = invalidManifestLocation
    ? ({ ok: false, error: "marketplace manifest path/name mismatch" } as const)
    : projected;
  const incomingMarkets = new Set(
    marketplaceProjection.ok ? marketplaceProjection.incomingMarketplaceNames : [],
  );
  const projectedMarkets = new Map(input.observation.facts.marketplacePayloads);
  for (const name of incomingMarkets) projectedMarkets.set(name, true);
  const transformObservation = {
    ...input.observation,
    facts: { ...input.observation.facts, marketplacePayloads: projectedMarkets },
  };
  const automaticTransforms = await transformPushInputs(captures, transformObservation, {
    ...(input.policyOverrides ?? {}),
  });
  const transformed = {
    ...automaticTransforms,
    codexConfig: applyResolvedCodexProfile(automaticTransforms.codexConfig, input.profile),
  };
  const pluginList = input.observation.facts.codexPluginList;
  const installedPlugins = new Set(pluginList.installed);
  const availablePlugins = new Set(
    marketplaceProjection.ok ? marketplaceProjection.availablePluginIds : pluginList.available,
  );
  const pluginInstalls = transformed.pluginDesires.filter(
    (pluginId) =>
      pluginList.status === "ok" &&
      !installedPlugins.has(pluginId) &&
      availablePlugins.has(pluginId),
  );
  const configuredPolicyIds = new Set(input.configuredPolicyIds ?? []);
  const profilePolicyIds = new Set(Object.keys(input.profile?.pluginPolicies ?? {}));
  const profilePluginPolicyCode = input.profile
    ? `profile.${input.profile.name}.plugin-policy`
    : undefined;
  const pluginWarnings = [
    ...(transformed.pluginDesires.length > 0 && pluginList.status !== "ok"
      ? [`plugin-list-${pluginList.status}`]
      : []),
    ...transformed.pluginDesires
      .filter(
        (pluginId) =>
          pluginList.status === "ok" &&
          !installedPlugins.has(pluginId) &&
          !availablePlugins.has(pluginId),
      )
      .map((pluginId) => `plugin-unavailable:${pluginId}`),
  ];
  let stagedIncoming = incoming;
  stagedIncoming = replaceTransformed(
    stagedIncoming,
    "claude/.mcp-config.json",
    transformed.claudeMcp,
  );
  stagedIncoming = replaceTransformed(stagedIncoming, "codex/config.toml", transformed.codexConfig);
  stagedIncoming = replaceTransformed(stagedIncoming, "codex/hooks.json", transformed.codexHooks);

  const mergePath = "claude/.mcp-config.json";
  const overlayIncoming = stagedIncoming.filter((entry) => entry.path !== mergePath);
  let stagedFinal = [...overlayInventory(input.observation.inventory, overlayIncoming)];
  const incomingSharedNames = new Set(
    stagedIncoming
      .filter((entry) => entry.path.startsWith("shared/agents/skills/"))
      .map((entry) => entry.path.split("/")[3])
      .filter((name): name is string => Boolean(name)),
  );
  const syncSharedSkills = input.preparedRequest.queries.sharedSkillNames === true;
  const sharedNames = new Set(
    syncSharedSkills ? [...input.observation.facts.sharedSkillNames, ...incomingSharedNames] : [],
  );
  if (sharedNames.size > 0) {
    for (const name of [...sharedNames].sort()) {
      const path = `claude/skills/${name}`;
      stagedFinal = stagedFinal.filter(
        (entry) => entry.path !== path && !entry.path.startsWith(`${path}/`),
      );
      stagedFinal.push(
        symlinkInventoryEntry(path, `${input.observation.facts.home}/.agents/skills/${name}`),
      );
    }
  }
  stagedFinal = [...canonicalInventory(stagedFinal)];

  const actions: MigrationActionInput[] = [];
  if (transformed.codexConfig || transformed.codexHooks)
    actions.push({
      operation: "transform",
      disposition:
        inventoryFingerprint(stagedIncoming.filter((entry) => entry.path.startsWith("codex/"))) ===
        inventoryFingerprint(incoming.filter((entry) => entry.path.startsWith("codex/")))
          ? "unchanged"
          : "update",
      phase: "materialize",
      scope: "codex",
      sourceRef: opaqueRef("source", "codex-host-inputs"),
      targetRef: opaqueRef("target", "codex-host-stage"),
      afterFingerprint: inventoryFingerprint(
        stagedIncoming.filter((entry) => entry.path.startsWith("codex/")),
      ),
      reversibility: "reversible",
      policyProvenance: [
        "host-adaptation.default",
        "plugin-policy.runtime",
        "trust-reset.default",
        ...(configuredPolicyIds.size > 0 ? ["plugin-policy.config"] : []),
        ...(profilePolicyIds.size > 0 && profilePluginPolicyCode ? [profilePluginPolicyCode] : []),
        ...(input.profile?.effectCodes.get("codex/config.toml")
          ? [input.profile.effectCodes.get("codex/config.toml") as string]
          : []),
      ],
    });
  if (transformed.claudeMcp) {
    const after = stagedIncoming.filter((entry) => entry.path === mergePath);
    const capturedMcp = input.observation.facts.captures.get("claude-mcp") ?? null;
    const sameMcp = capturedMcp !== null && Buffer.from(capturedMcp).equals(transformed.claudeMcp);
    actions.push({
      operation: "merge-json",
      disposition: capturedMcp === null ? "create" : sameMcp ? "unchanged" : "merge",
      phase: "materialize",
      scope: "claude",
      sourceRef: opaqueRef("source", "claude-mcp-input"),
      targetRef: opaqueRef("target", "claude-mcp-stage"),
      beforeFingerprint: fingerprint("push-capture-v1", {
        bytes: input.observation.facts.captures.get("claude-mcp")
          ? createHash("sha256")
              .update(input.observation.facts.captures.get("claude-mcp") as Uint8Array)
              .digest("hex")
          : null,
      }),
      afterFingerprint: inventoryFingerprint(after),
      reversibility: "reversible",
      policyProvenance: ["strict-json-merge.default"],
    });
    actions.push({
      operation: "overlay",
      disposition: sameMcp
        ? "unchanged"
        : input.observation.facts.captures.get("claude-mcp")
          ? "update"
          : "create",
      phase: "commit",
      scope: "claude",
      sourceRef: opaqueRef("source", "claude-mcp-stage"),
      targetRef: opaqueRef("target", "claude-mcp-live"),
      afterFingerprint: inventoryFingerprint(after),
      reversibility: "reversible",
      policyProvenance: ["atomic-file-write.default"],
    });
  }
  for (const scope of ["claude", "codex", "shared"] as const)
    for (const group of groupManagedTopLevelEntries(overlayIncoming).filter((group) =>
      scope === "shared" ? group.path.startsWith("shared/") : group.path.startsWith(`${scope}/`),
    ))
      actions.push(groupAction(group, input.observation.inventory, input.profile?.effectCodes));

  if (sharedNames.size > 0)
    actions.push({
      operation: "symlink",
      disposition:
        inventoryFingerprint(
          input.observation.inventory.filter((entry) => entry.path.startsWith("claude/skills/")),
        ) ===
        inventoryFingerprint(stagedFinal.filter((entry) => entry.path.startsWith("claude/skills/")))
          ? "unchanged"
          : "update",
      phase: "post-commit",
      scope: "claude",
      sourceRef: opaqueRef("source", "shared-skills-view"),
      targetRef: opaqueRef("target", "claude-skills-view"),
      afterFingerprint: inventoryFingerprint(
        stagedFinal.filter((entry) => entry.path.startsWith("claude/skills/")),
      ),
      reversibility: "reversible",
      policyProvenance: ["shared-skill-view.default"],
    });
  for (const pluginId of pluginInstalls)
    actions.push({
      operation: "external-effect",
      disposition: "update",
      phase: "post-commit",
      scope: "codex",
      sourceRef: opaqueRef("plugin-source", pluginId),
      targetRef: opaqueRef("plugin-target", pluginId),
      reversibility: "compensatable",
      policyProvenance: [
        "plugin-install.runtime",
        ...(profilePolicyIds.has(pluginId) && profilePluginPolicyCode
          ? [profilePluginPolicyCode]
          : configuredPolicyIds.has(pluginId)
            ? ["plugin-policy.config"]
            : ["plugin-policy.default"]),
      ],
    });

  const phaseRank = { materialize: 0, commit: 1, "post-commit": 2 } as const;
  actions.sort((left, right) => {
    const phase = phaseRank[left.phase] - phaseRank[right.phase];
    if (phase !== 0) return phase;
    if (left.phase === "commit") {
      const leftMcp = left.targetRef === opaqueRef("target", "claude-mcp-live") ? 1 : 0;
      const rightMcp = right.targetRef === opaqueRef("target", "claude-mcp-live") ? 1 : 0;
      return leftMcp - rightMcp;
    }
    return 0;
  });
  const dependencies: PlanDependency[] = [];
  const materialize = actions.filter((action) => action.phase === "materialize");
  for (const action of actions) {
    if (action.phase === "commit")
      for (const dependency of materialize.filter((item) => item.scope === action.scope))
        dependencies.push({
          id: `dep-${dependencies.length + 1}`,
          ownerActionId: deriveActionId(action),
          dependsOnActionId: deriveActionId(dependency),
          type: "data",
          required: true,
          status: "satisfied",
          resolution: "resolved",
        });
    if (action.phase === "post-commit")
      for (const dependency of actions.filter(
        (item) =>
          item.phase === "commit" &&
          (item.scope === action.scope ||
            (action.operation === "symlink" && item.scope === "shared")),
      ))
        dependencies.push({
          id: `dep-${dependencies.length + 1}`,
          ownerActionId: deriveActionId(action),
          dependsOnActionId: deriveActionId(dependency),
          type: "ordering",
          required: true,
          status: "satisfied",
          resolution: "resolved",
        });
  }
  const sourceFingerprint = inventoryFingerprint(incoming);
  const projectedCaptures = new Map(input.observation.facts.captures);
  if (transformed.claudeMcp) projectedCaptures.set("claude-mcp", transformed.claudeMcp);
  if (transformed.codexConfig) projectedCaptures.set("codex-config", transformed.codexConfig);
  const projectedPluginList =
    pluginList.status === "ok"
      ? (() => {
          const installed = [...new Set([...pluginList.installed, ...pluginInstalls])].sort();
          const installedSet = new Set(installed);
          return {
            status: "ok" as const,
            installed,
            available: [...availablePlugins].filter((id) => !installedSet.has(id)).sort(),
          };
        })()
      : pluginList;
  const filesystemPostFingerprint = pushStateFingerprint({
    capabilities: input.observation.capabilities,
    inventory: stagedFinal,
    facts: {
      ...input.observation.facts,
      captures: projectedCaptures,
      marketplacePayloads: projectedMarkets,
      sharedSkillNames: syncSharedSkills
        ? [...new Set([...input.observation.facts.sharedSkillNames, ...incomingSharedNames])].sort()
        : input.observation.facts.sharedSkillNames,
    },
  });
  const stagedPostFingerprint = pushStateFingerprint({
    capabilities: input.observation.capabilities,
    inventory: stagedFinal,
    facts: {
      ...input.observation.facts,
      captures: projectedCaptures,
      marketplacePayloads: projectedMarkets,
      sharedSkillNames: syncSharedSkills
        ? [...new Set([...input.observation.facts.sharedSkillNames, ...incomingSharedNames])].sort()
        : input.observation.facts.sharedSkillNames,
      codexPluginList: projectedPluginList,
    },
  });
  const unresolvedPlugins = transformed.pluginDesires.filter(
    (pluginId) =>
      !marketplaceProjection.ok ||
      pluginList.status !== "ok" ||
      (!installedPlugins.has(pluginId) && !availablePlugins.has(pluginId)),
  );
  const observedFingerprint = pushStateFingerprint(input.observation);
  const plan = createMigrationPlan({
    kind: "push",
    providers,
    profile: input.profile?.name,
    executionModel: "remote-staged-overlay",
    sourceEndpointRef: endpoint("push-source", sourceFingerprint),
    targetEndpointRef: endpoint("push-target", `${input.host}\0${observedFingerprint}`),
    sourceFingerprint,
    targetFingerprint: observedFingerprint,
    stagedPostFingerprint,
    preconditions: [
      {
        id: "collected-input-shape",
        required: true,
        status: "satisfied",
        reasonCode: "managed-members-valid",
      },
      {
        id: "prepared-observation-scope",
        required: true,
        status: "satisfied",
        reasonCode: "request-identity-matched",
        expectedFingerprint: input.preparedRequest.requestIdentity,
        observedFingerprint: input.observation.requestIdentity,
      },
      {
        id: "plugin-effects-resolved",
        required: true,
        status: unresolvedPlugins.length === 0 ? "satisfied" : "failed",
        reasonCode:
          unresolvedPlugins.length > 0
            ? "plugin-unavailable"
            : pluginList.status !== "ok"
              ? `plugin-list-${pluginList.status}`
              : "plugin-effects-resolved",
      },
      {
        id: "marketplace-projection-valid",
        required: manifests.length > 0,
        status: marketplaceProjection.ok ? "satisfied" : "failed",
        reasonCode: marketplaceProjection.ok
          ? "marketplace-projection-valid"
          : "marketplace-projection-invalid",
      },
      {
        id: "remote-target-shape",
        required: true,
        status: "satisfied",
        reasonCode: "managed-target-valid",
        observedFingerprint,
      },
    ],
    actions,
    dependencies,
    warnings: [...transformed.warnings, ...pluginWarnings, ...(input.profile?.warnings ?? [])].map(
      (warning) => ({
        code: warningCode(warning),
      }),
    ),
    policies: [
      { code: "deletion", valueCode: "none", provenance: "default" },
      {
        code: "plugin-policy",
        valueCode: configuredPolicyIds.size > 0 ? "configured" : "builtin",
        provenance: configuredPolicyIds.size > 0 ? "config" : "default",
      },
      ...(profilePolicyIds.size > 0
        ? [
            {
              code: "profile-plugin-policy",
              valueCode: input.profile?.name as string,
              provenance: "profile" as const,
            },
          ]
        : []),
      ...(input.profile
        ? [
            {
              code: "host-profile",
              valueCode: input.profile.name,
              provenance: "profile" as const,
            },
          ]
        : []),
    ],
    createdAt: input.createdAt,
  });
  const planned = Object.freeze({ plan });
  const actionBindings = new Map<string, PushActionBinding>();
  const groups = groupManagedTopLevelEntries(overlayIncoming);
  for (const action of actions) {
    const id = deriveActionId(action);
    if (action.operation === "transform")
      actionBindings.set(id, {
        kind: "materialize-codex",
        config: transformed.codexConfig && Buffer.from(transformed.codexConfig),
        hooks: transformed.codexHooks && Buffer.from(transformed.codexHooks),
      });
    else if (action.operation === "merge-json" && action.phase === "materialize")
      actionBindings.set(id, {
        kind: "materialize-claude-mcp",
        bytes: Buffer.from(transformed.claudeMcp as Uint8Array),
      });
    else if (action.targetRef === opaqueRef("target", "claude-mcp-live"))
      actionBindings.set(id, {
        kind: "write-claude-mcp",
        bytes: Buffer.from(transformed.claudeMcp as Uint8Array),
      });
    else if (action.operation === "overlay") {
      const group = groups.find((item) => opaqueRef("target", item.path) === action.targetRef);
      if (!group) throw new Error("Missing push overlay binding");
      actionBindings.set(id, {
        kind: "overlay-group",
        logicalGroup: group.path,
      });
    } else if (action.operation === "symlink")
      actionBindings.set(id, { kind: "symlink-view", names: [...sharedNames].sort() });
    else if (action.operation === "external-effect") {
      const pluginId = pluginInstalls.find(
        (item) => opaqueRef("plugin-target", item) === action.targetRef,
      );
      if (!pluginId) throw new Error("Missing push plugin binding");
      const codexCommand = input.observation.facts.commandPaths.get("codex");
      if (!codexCommand) throw new Error("Plugin install is missing observed Codex command path");
      actionBindings.set(id, { kind: "plugin-add", pluginId, codexCommand });
    }
  }
  const beforeRequest: PushExecutionObservationRequest = {
    ...input.preparedRequest,
  };
  const finalRequestBase = {
    host: input.host,
    inventoryRoots: [
      ...new Set(groupManagedTopLevelEntries(stagedFinal).map((group) => group.path)),
    ].sort(),
    queries: {
      ...input.preparedRequest.queries,
      sharedSkillNames: syncSharedSkills,
      marketplaceNames: [...projectedMarkets.keys()].sort(),
    },
  };
  const finalRequest: PushExecutionObservationRequest = {
    ...finalRequestBase,
    requestIdentity: pushObservationRequestIdentity(finalRequestBase),
  };
  const transformedBytes = new Map<string, Uint8Array>();
  if (transformed.claudeMcp) transformedBytes.set("claude/.mcp-config.json", transformed.claudeMcp);
  if (transformed.codexConfig) transformedBytes.set("codex/config.toml", transformed.codexConfig);
  if (transformed.codexHooks) transformedBytes.set("codex/hooks.json", transformed.codexHooks);
  const verificationCodexPluginList =
    input.preparedRequest.queries.codexPluginList === true && projectedPluginList.status === "ok";
  resources.set(planned, {
    files: files.map((file) => Object.freeze({ ...file })),
    sourceInventory: canonicalInventory(incoming),
    stagedIncoming: canonicalInventory(stagedIncoming),
    actionBindings,
    beforeRequest,
    finalRequest,
    filesystemPostFingerprint,
    verificationPostFingerprint: managedStateVerificationFingerprint(
      canonicalInventory([
        ...stagedFinal,
        ...(transformed.claudeMcp ? [claudeMcpManagedEntry(transformed.claudeMcp)] : []),
      ]),
      verificationCodexPluginList && projectedPluginList.status === "ok"
        ? projectedPluginList
        : undefined,
    ),
    verificationClaudeMcp: transformed.claudeMcp !== undefined,
    verificationCodexPluginList,
    sources: sealPushSourceBindings(files),
    transformedBytes,
    decisionFiles,
    decisionHashes,
    profile: input.profile,
  });
  return planned;
}

export async function executePlannedPush(
  planned: PlannedPush,
  adapter: PushExecutionAdapter,
  options: { readonly context?: RuntimeContext } = {},
): Promise<string | undefined> {
  const resource = resources.get(planned);
  if (!resource) throw new Error("Push plan is forged or already consumed");
  if (resource.profile) await verifyPushProfileAssets(resource.profile);
  if (planned.plan.status === "blocked") throw new Error("Blocked push plan cannot execute");
  const actionIds = new Set(planned.plan.actions.map((action) => action.id));
  const bindingIds = new Set(resource.actionBindings.keys());
  if (
    actionIds.size !== planned.plan.actions.length ||
    actionIds.size !== bindingIds.size ||
    [...actionIds].some((id) => !bindingIds.has(id))
  )
    throw new Error("Push action binding set does not match the plan");
  const indexes = new Map(planned.plan.actions.map((action, index) => [action.id, index]));
  for (const dependency of planned.plan.dependencies)
    if (
      !actionIds.has(dependency.ownerActionId) ||
      !actionIds.has(dependency.dependsOnActionId) ||
      (indexes.get(dependency.dependsOnActionId) as number) >=
        (indexes.get(dependency.ownerActionId) as number)
    )
      throw new Error(`Push action dependency is out of order: ${dependency.id}`);
  const currentSourceInventory = await inventoryFromFileEntries(resource.files);
  if (
    inventoryFingerprint(currentSourceInventory) !==
      inventoryFingerprint(resource.sourceInventory) ||
    inventoryFingerprint(currentSourceInventory) !== planned.plan.sourceFingerprint
  )
    throw new Error("Push source changed after planning");
  for (const file of resource.decisionFiles) {
    const bytes =
      file.mcpServersOnly === undefined
        ? await readFile(file.sourcePath)
        : Buffer.from(file.mcpServersOnly);
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      resource.decisionHashes.get(file.relativePath)
    )
      throw new Error(`Push decision input changed after planning: ${file.relativePath}`);
  }
  const staged =
    planned.plan.status === "noop"
      ? undefined
      : await stagePushArchive({
          sources: resource.sources,
          transformedBytes: resource.transformedBytes,
          expectedSourceInventory: resource.sourceInventory,
          expectedStagedInventory: resource.stagedIncoming,
          providers: planned.plan.providers,
        });
  let session: PushExecutionSession | undefined;
  const failures: unknown[] = [];
  let committed = false;
  let completed = false;
  let mutationStarted = false;
  let receipt: ExecutionReceipt | undefined;
  let observedPostFingerprint: PlanFingerprint | undefined;
  let observedManagedStateFingerprint: PlanFingerprint | undefined;
  let rollbackVerified = false;
  let failedEffects = false;
  let cleanupPending = false;
  let transportMetrics:
    | { readonly transferredBytes: number | null; readonly reusedBytes: number | null }
    | undefined;
  let recoveryRequired = false;
  let receiptFinalizationError: unknown;
  const attemptedActions = new Set<string>();
  const completedActions = new Set<string>();
  try {
    const observed = await adapter.observe(resource.beforeRequest);
    if (
      observed.requestIdentity !== resource.beforeRequest.requestIdentity ||
      pushStateFingerprint(observed) !== planned.plan.targetFingerprint
    )
      throw new Error("Push target changed after planning");
    if (planned.plan.status !== "noop" && options.context) {
      try {
        receipt = await startExecutionReceipt(options.context, planned.plan, {
          filesystemPostFingerprint: resource.filesystemPostFingerprint,
          verification: {
            mode: "remote",
            endpointRef: executionReceiptEndpointRef("remote", resource.beforeRequest.host),
            inventoryRoots: [
              ...resource.finalRequest.inventoryRoots,
              ...(resource.verificationClaudeMcp ? ["claude/.mcp-config.json"] : []),
            ].sort(),
            claudeMcp: resource.verificationClaudeMcp,
            codexPluginList: resource.verificationCodexPluginList,
            beforeFingerprint: pushVerificationFingerprint(observed, {
              claudeMcp: resource.verificationClaudeMcp,
              codexPluginList: resource.verificationCodexPluginList,
            }),
            plannedFingerprint: resource.verificationPostFingerprint,
          },
        });
      } catch (error) {
        if (!(error instanceof ReceiptPublicationAmbiguousError)) throw error;
        try {
          receipt = await reconcileExecutionReceiptPublication(options.context, error.receiptId);
          if (receipt.outcome !== "started" || receipt.planId !== planned.plan.id)
            throw new Error("Ambiguous push receipt does not match the execution plan");
        } catch (readError) {
          throw new ExecutionError("Push receipt creation outcome could not be reconciled", {
            cause: new AggregateError([error, readError]),
          });
        }
      }
      for (const action of planned.plan.actions)
        if (action.phase === "materialize" && action.disposition !== "unchanged")
          completedActions.add(action.id);
    }
    const changedRemote = planned.plan.actions.some(
      (action) =>
        action.phase !== "materialize" &&
        action.disposition !== "unchanged" &&
        action.disposition !== "preserve",
    );
    if (changedRemote) {
      if (!staged) throw new Error("Changed push plan has no staged archive");
      const changedActions = planned.plan.actions.flatMap((action) => {
        if (
          action.phase === "materialize" ||
          action.disposition === "unchanged" ||
          action.disposition === "preserve"
        )
          return [];
        const binding = resource.actionBindings.get(action.id);
        if (!binding) throw new Error(`Missing push action binding: ${action.id}`);
        return [{ action, binding }];
      });
      session = await adapter.prepare({
        archivePath: staged.archivePath,
        archiveSha256: staged.archiveSha256,
        archiveSize: staged.archiveSize,
        treePath: staged.treePath,
        snapshotId: staged.snapshotId,
        stagedInventory: resource.stagedIncoming,
        observationRequest: resource.beforeRequest,
        observation: observed,
        actions: changedActions,
      });
    }
    const consumed = new Set<string>();
    for (const action of planned.plan.actions) {
      for (const dependency of planned.plan.dependencies.filter(
        (item) => item.required && item.ownerActionId === action.id,
      ))
        if (!consumed.has(dependency.dependsOnActionId))
          throw new Error(`Push action dependency was not consumed: ${dependency.id}`);
      const binding = resource.actionBindings.get(action.id);
      if (!binding) throw new Error(`Missing push action binding: ${action.id}`);
      if (
        action.phase === "materialize" ||
        action.disposition === "unchanged" ||
        action.disposition === "preserve"
      ) {
        consumed.add(action.id);
        continue;
      }
      if (!mutationStarted) {
        resources.delete(planned);
        mutationStarted = true;
      }
      if (!session) throw new Error("Push execution session was not prepared");
      if (binding.kind !== "plugin-add") {
        attemptedActions.add(action.id);
        await session.apply(action, binding);
        completedActions.add(action.id);
      }
      consumed.add(action.id);
    }
    if (consumed.size !== resource.actionBindings.size)
      throw new Error("Push action bindings were not consumed exactly once");
    const effectActions = planned.plan.actions.filter(
      (action) => resource.actionBindings.get(action.id)?.kind === "plugin-add",
    );
    const filesystemFinal = await adapter.observe(resource.finalRequest, { mutationStarted: true });
    if (filesystemFinal.requestIdentity !== resource.finalRequest.requestIdentity)
      throw new ExecutionError("Push filesystem observation does not match its request");
    observedPostFingerprint = pushStateFingerprint(filesystemFinal);
    observedManagedStateFingerprint = pushVerificationFingerprint(filesystemFinal, {
      claudeMcp: resource.verificationClaudeMcp,
      codexPluginList: resource.verificationCodexPluginList,
    });
    if (observedPostFingerprint !== resource.filesystemPostFingerprint)
      throw new ExecutionError("Push filesystem target does not match the planned post-state");
    await session?.commit();
    committed = session !== undefined;
    for (const action of effectActions) {
      const binding = resource.actionBindings.get(action.id);
      if (binding?.kind === "plugin-add") {
        attemptedActions.add(action.id);
        try {
          await session?.applyEffect(action, binding);
          completedActions.add(action.id);
        } catch (error) {
          observedPostFingerprint = undefined;
          observedManagedStateFingerprint = undefined;
          if (error instanceof ExecutionError && error.message === "committed_with_failed_effects")
            throw error;
          throw new ExecutionError("committed_effect_recovery_required", { cause: error });
        }
      }
    }
    observedPostFingerprint = undefined;
    observedManagedStateFingerprint = undefined;
    const final = await adapter.observe(resource.finalRequest, { mutationStarted: true });
    if (final.requestIdentity !== resource.finalRequest.requestIdentity)
      throw new ExecutionError("Push final observation does not match its request");
    observedPostFingerprint = pushStateFingerprint(final);
    observedManagedStateFingerprint = pushVerificationFingerprint(final, {
      claudeMcp: resource.verificationClaudeMcp,
      codexPluginList: resource.verificationCodexPluginList,
    });
    if (observedPostFingerprint !== planned.plan.stagedPostFingerprint)
      throw new ExecutionError("Push target does not match the planned post-state");
    await session?.verifyCommit();
    resources.delete(planned);
    completed = true;
  } catch (error) {
    failures.push(error);
    if (
      !session &&
      error instanceof ExecutionError &&
      error.message === "Remote push preparation requires recovery"
    ) {
      recoveryRequired = true;
      resources.delete(planned);
    }
    committed ||= session?.isCommitted() === true;
    if (committed) {
      const message =
        error instanceof ExecutionError && error.message === "committed_with_failed_effects"
          ? "committed_with_failed_effects"
          : error instanceof ExecutionError &&
              error.message === "committed_effect_recovery_required"
            ? "committed_effect_recovery_required"
            : error instanceof ExecutionError && error.message.includes("retention_cleanup_pending")
              ? "committed_with_retention_cleanup_pending"
              : "committed_verification_failed";
      failures[0] = new ExecutionError(message, { cause: error });
      if (message === "committed_with_failed_effects" && session) {
        failedEffects = true;
        observedPostFingerprint = undefined;
        try {
          await session.acknowledgeFailedEffects();
          try {
            const partial = await adapter.observe(resource.finalRequest, {
              mutationStarted: true,
            });
            if (partial.requestIdentity === resource.finalRequest.requestIdentity) {
              observedPostFingerprint = pushStateFingerprint(partial);
              observedManagedStateFingerprint = pushVerificationFingerprint(partial, {
                claudeMcp: resource.verificationClaudeMcp,
                codexPluginList: resource.verificationCodexPluginList,
              });
            }
          } catch {
            // The helper terminal state is known even when target observation is unavailable.
          }
          await session.verifyCommit();
          await session.cleanup();
        } catch (recoveryError) {
          cleanupPending = true;
          failures.push(recoveryError);
        }
      }
      session = undefined;
      if (message !== "committed_with_failed_effects") recoveryRequired = true;
    } else if (session) {
      if (mutationStarted && !(failures[0] instanceof ExecutionError))
        failures[0] = new ExecutionError("Push execution failed after mutation started", {
          cause: error,
        });
      observedPostFingerprint = undefined;
      observedManagedStateFingerprint = undefined;
      try {
        await session.abort();
      } catch (recoveryError) {
        failures.push(recoveryError);
        session = undefined;
        recoveryRequired = true;
      }
      if (session) {
        try {
          const restored = await adapter.observe(resource.beforeRequest, { mutationStarted: true });
          if (restored.requestIdentity !== resource.beforeRequest.requestIdentity)
            throw new ExecutionError("Rollback observation does not match its request");
          observedPostFingerprint = pushStateFingerprint(restored);
          observedManagedStateFingerprint = pushVerificationFingerprint(restored, {
            claudeMcp: resource.verificationClaudeMcp,
            codexPluginList: resource.verificationCodexPluginList,
          });
          if (observedPostFingerprint !== planned.plan.targetFingerprint)
            throw new ExecutionError("Rollback did not restore the planned target state");
          await session.verifyRollback();
          rollbackVerified = true;
        } catch (recoveryError) {
          failures.push(recoveryError);
          session = undefined;
          recoveryRequired = true;
        }
      }
    }
  }
  if (session) {
    try {
      await session.cleanup();
    } catch (error) {
      cleanupPending = true;
      failures.push(error);
    }
  }
  try {
    await staged?.cleanup();
  } catch (error) {
    cleanupPending = true;
    failures.push(error);
  }
  transportMetrics = adapter.transportMetrics?.();
  if (receipt && options.context) {
    const primary = failures[0];
    const outcome: Exclude<ExecutionReceiptOutcome, "started"> = completed
      ? "succeeded"
      : failedEffects
        ? "committed_with_failed_effects"
        : recoveryRequired
          ? "recovery_required"
          : rollbackVerified
            ? "rolled_back"
            : "failed";
    const observed =
      outcome === "rolled_back"
        ? planned.plan.targetFingerprint
        : outcome === "succeeded"
          ? planned.plan.stagedPostFingerprint
          : observedPostFingerprint;
    try {
      await finishExecutionReceipt(options.context, receipt, {
        outcome,
        finishedAt: options.context.now(),
        actions: pushReceiptActions(
          receipt,
          resource,
          outcome,
          attemptedActions,
          completedActions,
          committed,
        ),
        ...(observed === undefined ? {} : { observedPostFingerprint: observed }),
        ...(observedManagedStateFingerprint === undefined
          ? {}
          : { observedManagedStateFingerprint }),
        warnings: pushReceiptWarnings(primary, outcome, cleanupPending),
        ...(transportMetrics?.transferredBytes == null
          ? {}
          : { transferredBytes: transportMetrics.transferredBytes }),
        ...(transportMetrics?.reusedBytes == null
          ? {}
          : { reusedBytes: transportMetrics.reusedBytes }),
      });
    } catch (receiptError) {
      receiptFinalizationError = receiptError;
    }
  }
  if (receiptFinalizationError !== undefined) {
    if (failures.length === 0)
      throw new ExecutionError("Push reached a terminal state but receipt publication failed", {
        cause: receiptFinalizationError,
      });
    throw new ExecutionError("Push failed and receipt finalization also failed", {
      cause: new AggregateError([...failures, receiptFinalizationError]),
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new ExecutionError("Push failed with recovery or cleanup errors", {
      cause: new AggregateError(failures),
    });
  if (!completed) throw new ExecutionError("Push did not reach a terminal outcome");
  return receipt?.id;
}

function pushReceiptActions(
  receipt: ExecutionReceipt,
  resource: PushPlanResources,
  outcome: Exclude<ExecutionReceiptOutcome, "started">,
  attempted: ReadonlySet<string>,
  completed: ReadonlySet<string>,
  committed: boolean,
): ExecutionReceiptAction[] {
  return receipt.actions.map((action) => {
    if (action.outcome === "skipped") return action;
    if (outcome === "succeeded") return { ...action, outcome: "succeeded" };
    const binding = resource.actionBindings.get(action.id);
    if (completed.has(action.id)) {
      const localMaterialization =
        binding?.kind === "materialize-codex" || binding?.kind === "materialize-claude-mcp";
      if (outcome === "recovery_required" && !committed && !localMaterialization)
        return { ...action, outcome: "unknown" };
      return { ...action, outcome: committed || localMaterialization ? "succeeded" : "failed" };
    }
    if (attempted.has(action.id))
      return { ...action, outcome: outcome === "recovery_required" ? "unknown" : "failed" };
    return { ...action, outcome: "skipped" };
  });
}

function pushReceiptWarnings(
  error: unknown,
  outcome: Exclude<ExecutionReceiptOutcome, "started">,
  cleanupPending: boolean,
): string[] {
  const warnings: string[] = [];
  if (outcome === "committed_with_failed_effects") warnings.push("committed-with-failed-effects");
  if (outcome === "recovery_required") warnings.push("recovery-required");
  if (cleanupPending) warnings.push("terminal-cleanup-pending");
  if (error instanceof ExecutionError && error.message.includes("retention_cleanup_pending"))
    warnings.push("retention-cleanup-pending");
  if (error instanceof ExecutionError && error.message.includes("verification"))
    warnings.push("terminal-verification-failed");
  return warnings;
}
