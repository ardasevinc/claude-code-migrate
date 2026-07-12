import { createHash } from "node:crypto";
import type { ProviderName } from "../types/index.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type PlanFingerprint = `fp_${string}`;
export type PlanId = `plan_${string}`;
export type ActionId = `action_${string}`;

export interface RedactedEndpoint {
  readonly kind: "source" | "target";
  readonly fingerprint: PlanFingerprint;
}
export type MigrationKind = "backup" | "push" | "restore";
export type LogicalRef = string;
export type SymbolicCode = string;

export interface PlanPrecondition {
  readonly id: string;
  readonly required: boolean;
  readonly status: "satisfied" | "failed" | "unknown";
  readonly reasonCode: SymbolicCode;
  readonly expectedFingerprint?: PlanFingerprint;
  readonly observedFingerprint?: PlanFingerprint;
}

export interface PlanWarning {
  readonly code: SymbolicCode;
}

export interface PlanDependency {
  readonly id: string;
  readonly ownerActionId: ActionId;
  readonly dependsOnActionId: ActionId;
  readonly type: "ordering" | "data";
  readonly required: boolean;
  readonly status: "satisfied" | "failed" | "unknown";
  readonly resolution: "resolved" | "unresolved";
}

export interface PlanPolicy {
  readonly code: SymbolicCode;
  readonly value: JsonValue;
  readonly provenance: "default" | "profile" | "cli" | "runtime";
}

export type ActionOperation =
  | "archive"
  | "overlay"
  | "merge-json"
  | "transform"
  | "symlink"
  | "external-effect";
export type ActionDisposition = "create" | "update" | "unchanged" | "merge" | "preserve";
export interface MigrationAction {
  readonly id: ActionId;
  readonly operation: ActionOperation;
  readonly disposition: ActionDisposition;
  readonly phase: "materialize" | "commit" | "post-commit";
  readonly scope: "claude" | "codex" | "shared";
  readonly targetRef: LogicalRef;
  readonly sourceRef?: LogicalRef;
  readonly beforeFingerprint?: PlanFingerprint;
  readonly afterFingerprint?: PlanFingerprint;
  readonly reversibility: "reversible" | "compensatable" | "irreversible";
  readonly policyProvenance: readonly SymbolicCode[];
}

export type MigrationPlanStatus = "ready" | "blocked" | "noop";
export interface MigrationPlan {
  readonly schemaVersion: 2;
  readonly id: PlanId;
  readonly kind: MigrationKind;
  readonly providers: readonly ProviderName[];
  readonly profile?: SymbolicCode;
  readonly executionModel: SymbolicCode;
  readonly source: RedactedEndpoint;
  readonly target: RedactedEndpoint;
  readonly sourceFingerprint: PlanFingerprint;
  readonly targetFingerprint: PlanFingerprint;
  readonly stagedPostFingerprint: PlanFingerprint;
  readonly preconditions: readonly PlanPrecondition[];
  readonly actions: readonly MigrationAction[];
  readonly dependencies: readonly PlanDependency[];
  readonly warnings: readonly PlanWarning[];
  readonly policies: readonly PlanPolicy[];
  readonly status: MigrationPlanStatus;
  readonly createdAt: string;
}

export interface MigrationActionInput extends Omit<MigrationAction, "id"> {}
export interface MigrationPlanInput
  extends Omit<
    MigrationPlan,
    "schemaVersion" | "id" | "status" | "source" | "target" | "actions" | "createdAt"
  > {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly actions: readonly MigrationActionInput[];
  readonly createdAt?: string;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key] as JsonValue)}`)
    .join(",")}}`;
}
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${canonicalJson(value as JsonValue)}`)
    .digest("hex");
}
export function fingerprint(domain: string, value: JsonValue): PlanFingerprint {
  return `fp_${digest(`ccm:fingerprint:${domain}`, value)}`;
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const SAFE_CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_REF = /^[a-z][a-z0-9]*(?:[/:._-][a-z0-9]+)*$/;
function assertSafe(value: string, kind: string, pattern = SAFE_CODE): void {
  if (!pattern.test(value)) throw new Error(`${kind} must be a safe symbolic value: ${value}`);
}
function endpoint(kind: RedactedEndpoint["kind"], raw: string): RedactedEndpoint {
  if (!raw) throw new Error(`${kind} endpoint must not be empty`);
  return { kind, fingerprint: fingerprint(`endpoint:${kind}`, raw) };
}
function buildAction(input: MigrationActionInput): MigrationAction {
  assertSafe(input.targetRef, "targetRef", SAFE_REF);
  if (input.sourceRef) assertSafe(input.sourceRef, "sourceRef", SAFE_REF);
  for (const code of input.policyProvenance) assertSafe(code, "policy provenance");
  return {
    id: `action_${digest("ccm:action-id", { operation: input.operation, scope: input.scope, targetRef: input.targetRef })}`,
    ...input,
  };
}

function validateUnique(values: readonly string[], kind: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${kind} id`);
}
function validateGraph(
  actions: readonly MigrationAction[],
  dependencies: readonly PlanDependency[],
): void {
  const ids = new Set(actions.map((action) => action.id));
  validateUnique(
    actions.map((action) => action.id),
    "action",
  );
  validateUnique(
    dependencies.map((dependency) => dependency.id),
    "dependency",
  );
  const graph = new Map<ActionId, ActionId[]>();
  for (const action of actions) graph.set(action.id, []);
  for (const dependency of dependencies) {
    assertSafe(dependency.id, "dependency id");
    if (!ids.has(dependency.ownerActionId) || !ids.has(dependency.dependsOnActionId))
      throw new Error(`dependency ${dependency.id} has unknown action reference`);
    if (dependency.ownerActionId === dependency.dependsOnActionId)
      throw new Error(`dependency ${dependency.id} is self-referential`);
    graph.get(dependency.ownerActionId)?.push(dependency.dependsOnActionId);
  }
  const visiting = new Set<ActionId>();
  const visited = new Set<ActionId>();
  const visit = (id: ActionId): void => {
    if (visiting.has(id)) throw new Error("cyclic action dependency graph");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function derivePlanStatus(
  actions: readonly MigrationAction[],
  preconditions: readonly PlanPrecondition[],
  dependencies: readonly PlanDependency[],
): MigrationPlanStatus {
  if (
    preconditions.some((item) => item.required && item.status !== "satisfied") ||
    dependencies.some(
      (item) => item.required && (item.status !== "satisfied" || item.resolution !== "resolved"),
    )
  )
    return "blocked";
  return actions.some(
    (action) =>
      action.disposition === "create" ||
      action.disposition === "update" ||
      action.disposition === "merge",
  )
    ? "ready"
    : "noop";
}

export function createMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("createdAt must be a valid date");
  if (input.profile) assertSafe(input.profile, "profile");
  assertSafe(input.executionModel, "execution model");
  if (new Set(input.providers).size !== input.providers.length)
    throw new Error("duplicate provider");
  input.preconditions.forEach((item) => {
    assertSafe(item.id, "precondition id");
    assertSafe(item.reasonCode, "precondition reason code");
  });
  for (const item of input.warnings) assertSafe(item.code, "warning code");
  for (const item of input.policies) assertSafe(item.code, "policy code");
  validateUnique(
    input.preconditions.map((item) => item.id),
    "precondition",
  );
  const actions = input.actions.map(buildAction);
  validateGraph(actions, input.dependencies);
  const semantic = {
    schemaVersion: 2 as const,
    kind: input.kind,
    providers: input.providers,
    profile: input.profile,
    executionModel: input.executionModel,
    source: endpoint("source", input.sourceEndpoint),
    target: endpoint("target", input.targetEndpoint),
    sourceFingerprint: input.sourceFingerprint,
    targetFingerprint: input.targetFingerprint,
    stagedPostFingerprint: input.stagedPostFingerprint,
    preconditions: input.preconditions,
    actions,
    dependencies: input.dependencies,
    warnings: input.warnings,
    policies: input.policies,
    status: derivePlanStatus(actions, input.preconditions, input.dependencies),
  };
  return deepFreeze({ ...semantic, id: `plan_${digest("ccm:plan-id", semantic)}`, createdAt });
}

export interface MigrationPlanDiff {
  readonly changed: boolean;
  readonly added: readonly ActionId[];
  readonly removed: readonly ActionId[];
  readonly changedActions: readonly ActionId[];
}
export function diffMigrationPlans(before: MigrationPlan, after: MigrationPlan): MigrationPlanDiff {
  const previous = new Map(before.actions.map((action) => [action.id, action]));
  const next = new Map(after.actions.map((action) => [action.id, action]));
  const added = [...next.keys()].filter((id) => !previous.has(id)).sort();
  const removed = [...previous.keys()].filter((id) => !next.has(id)).sort();
  const changedActions = [...next.keys()]
    .filter(
      (id) =>
        previous.has(id) &&
        canonicalJson(previous.get(id) as unknown as JsonValue) !==
          canonicalJson(next.get(id) as unknown as JsonValue),
    )
    .sort();
  return deepFreeze({ changed: before.id !== after.id, added, removed, changedActions });
}
