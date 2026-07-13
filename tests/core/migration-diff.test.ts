import { describe, expect, it } from "vitest";
import { projectMigrationDiff } from "../../src/core/migration-diff.ts";
import { createMigrationPlan, fingerprint } from "../../src/core/migration-plan.ts";

const fp = (value: string) => fingerprint("diff-test", value);

describe("migration diff projection", () => {
  it("separates noop materialization from managed-state changes", () => {
    const plan = createMigrationPlan({
      kind: "restore",
      providers: ["codex"],
      executionModel: "transactional-local-v1",
      sourceEndpointRef: "endpoint_0123456789abcdef0123456789abcdef",
      targetEndpointRef: "endpoint_fedcba9876543210fedcba9876543210",
      sourceFingerprint: fp("source"),
      targetFingerprint: fp("target"),
      stagedPostFingerprint: fp("target"),
      preconditions: [],
      actions: [
        {
          operation: "transform",
          disposition: "update",
          phase: "materialize",
          scope: "codex",
          targetRef: "codex/staged-config",
          sourceRef: "archive/codex-config",
          reversibility: "reversible",
          policyProvenance: ["trust.strip"],
        },
        {
          operation: "overlay",
          disposition: "unchanged",
          phase: "commit",
          scope: "codex",
          targetRef: "codex/config",
          reversibility: "reversible",
          policyProvenance: ["managed.overlay"],
        },
      ],
      dependencies: [],
      warnings: [],
      policies: [],
      createdAt: "2026-07-13T12:00:00.000Z",
    });

    expect(plan.status).toBe("noop");
    expect(projectMigrationDiff(plan).counts).toMatchObject({
      actions: 2,
      changed: 0,
      materializations: 1,
    });
  });
});
