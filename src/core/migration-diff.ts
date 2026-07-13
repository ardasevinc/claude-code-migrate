import type {
  ActionDisposition,
  MigrationAction,
  MigrationPlan,
  MigrationPlanStatus,
  PlanId,
} from "./migration-plan.ts";

const dispositions = ["create", "update", "merge", "unchanged", "preserve"] as const;

export interface MigrationDiffProjection {
  readonly schemaVersion: 1;
  readonly kind: "diff";
  readonly migrationKind: MigrationPlan["kind"];
  readonly planId: PlanId;
  readonly status: MigrationPlanStatus;
  readonly counts: {
    readonly actions: number;
    readonly changed: number;
    readonly materializations: number;
    readonly byDisposition: Readonly<Record<ActionDisposition, number>>;
  };
  readonly actions: readonly MigrationAction[];
}

export function projectMigrationDiff(plan: MigrationPlan): MigrationDiffProjection {
  const byDisposition = Object.fromEntries(
    dispositions.map((disposition) => [
      disposition,
      plan.actions.filter((action) => action.disposition === disposition).length,
    ]),
  ) as Record<ActionDisposition, number>;
  return {
    schemaVersion: 1,
    kind: "diff",
    migrationKind: plan.kind,
    planId: plan.id,
    status: plan.status,
    counts: {
      actions: plan.actions.length,
      changed: plan.actions.filter(
        (action) =>
          action.phase !== "materialize" &&
          action.disposition !== "unchanged" &&
          action.disposition !== "preserve",
      ).length,
      materializations: plan.actions.filter(
        (action) =>
          action.phase === "materialize" &&
          action.disposition !== "unchanged" &&
          action.disposition !== "preserve",
      ).length,
      byDisposition,
    },
    actions: plan.actions,
  };
}
