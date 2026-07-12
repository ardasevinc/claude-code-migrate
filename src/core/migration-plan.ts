import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PlanFingerprint = `fp_${string}`;
export type PlanId = `plan_${string}`;
export type ActionId = `action_${string}`;

export interface RedactedIdentity {
  readonly kind: "source" | "destination";
  readonly fingerprint: PlanFingerprint;
}

export interface PlanPrecondition {
  readonly code: string;
  readonly satisfied: boolean;
  readonly fingerprint: PlanFingerprint;
}

export interface PlanNotice {
  readonly code: string;
  readonly level: "info" | "warning" | "error";
}

export interface PlanDependency {
  readonly actionId: ActionId;
}

export interface PlanPolicy {
  readonly conflict: "skip" | "overwrite" | "merge";
  readonly secrets: "exclude" | "redact";
}

export type MigrationActionDisposition = "create" | "update" | "skip";

export interface MigrationAction {
  readonly actionId: ActionId;
  readonly provider: "claude" | "codex" | "shared";
  readonly resource: string;
  readonly disposition: MigrationActionDisposition;
  readonly fingerprint: PlanFingerprint;
  readonly preconditions: readonly PlanPrecondition[];
  readonly dependencies: readonly PlanDependency[];
  readonly notices: readonly PlanNotice[];
}

export type MigrationPlanStatus = "ready" | "blocked" | "noop";

export interface MigrationPlan {
  readonly formatVersion: 1;
  readonly planId: PlanId;
  readonly createdAt: string;
  readonly source: RedactedIdentity;
  readonly destination: RedactedIdentity;
  readonly policy: PlanPolicy;
  readonly actions: readonly MigrationAction[];
  readonly notices: readonly PlanNotice[];
  readonly status: MigrationPlanStatus;
}

export interface MigrationActionInput {
  readonly provider: MigrationAction["provider"];
  readonly resource: string;
  readonly disposition: MigrationActionDisposition;
  readonly preconditions?: readonly Omit<PlanPrecondition, "fingerprint">[];
  readonly dependencies?: readonly ActionId[];
  readonly notices?: readonly PlanNotice[];
}

export interface MigrationPlanInput {
  readonly sourceIdentity: string;
  readonly destinationIdentity: string;
  readonly policy: PlanPolicy;
  readonly actions: readonly MigrationActionInput[];
  readonly notices?: readonly PlanNotice[];
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

export function redactIdentity(
  kind: RedactedIdentity["kind"],
  rawIdentity: string,
): RedactedIdentity {
  if (!rawIdentity) throw new Error(`${kind} identity must not be empty`);
  return deepFreeze({ kind, fingerprint: fingerprint(`identity:${kind}`, rawIdentity) });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function derivePlanStatus(actions: readonly MigrationAction[]): MigrationPlanStatus {
  if (actions.some((action) => action.preconditions.some((item) => !item.satisfied))) {
    return "blocked";
  }
  return actions.every((action) => action.disposition === "skip") ? "noop" : "ready";
}

function buildAction(input: MigrationActionInput): MigrationAction {
  const preconditions = (input.preconditions ?? []).map((item) => ({
    ...item,
    fingerprint: fingerprint("precondition", item),
  }));
  const semantic = {
    provider: input.provider,
    resource: input.resource,
    disposition: input.disposition,
    preconditions,
    dependencies: (input.dependencies ?? []).map((actionId) => ({ actionId })),
    notices: input.notices ?? [],
  } satisfies Omit<MigrationAction, "actionId" | "fingerprint">;
  const actionFingerprint = fingerprint("action", semantic as unknown as JsonValue);
  return {
    actionId: `action_${digest("ccm:action-id", semantic)}`,
    ...semantic,
    fingerprint: actionFingerprint,
  };
}

export function createMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("createdAt must be a valid date");
  const actions = input.actions.map(buildAction);
  const semantic = {
    formatVersion: 1 as const,
    source: redactIdentity("source", input.sourceIdentity),
    destination: redactIdentity("destination", input.destinationIdentity),
    policy: input.policy,
    actions,
    notices: input.notices ?? [],
    status: derivePlanStatus(actions),
  };
  return deepFreeze({
    ...semantic,
    planId: `plan_${digest("ccm:plan-id", semantic)}`,
    createdAt,
  });
}

export interface MigrationPlanDiff {
  readonly changed: boolean;
  readonly added: readonly ActionId[];
  readonly removed: readonly ActionId[];
}

export function diffMigrationPlans(before: MigrationPlan, after: MigrationPlan): MigrationPlanDiff {
  const previous = new Set(before.actions.map((action) => action.actionId));
  const next = new Set(after.actions.map((action) => action.actionId));
  return deepFreeze({
    changed: before.planId !== after.planId,
    added: [...next].filter((id) => !previous.has(id)).sort(),
    removed: [...previous].filter((id) => !next.has(id)).sort(),
  });
}
