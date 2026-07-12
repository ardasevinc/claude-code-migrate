import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createMigrationPlan,
  diffMigrationPlans,
  type MigrationPlanInput,
} from "../../src/core/migration-plan.ts";

const base = (overrides: Partial<MigrationPlanInput> = {}): MigrationPlanInput => ({
  sourceIdentity: "source-host-canary.example",
  destinationIdentity: "destination-host-canary.example",
  policy: { conflict: "merge", secrets: "redact" },
  actions: [
    {
      provider: "codex",
      resource: "configuration",
      disposition: "update",
      preconditions: [{ code: "destination-writable", satisfied: true }],
      notices: [{ code: "merge-required", level: "info" }],
    },
  ],
  createdAt: "2026-07-12T12:00:00.000Z",
  ...overrides,
});

describe("migration plan primitives", () => {
  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
  });

  it("redacts raw identities and deeply freezes the returned JSON graph", () => {
    const plan = createMigrationPlan(base());
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("source-host-canary");
    expect(serialized).not.toContain("destination-host-canary");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(Object.isFrozen(plan.actions[0]?.preconditions)).toBe(true);
    expect(() => {
      (plan.policy as { conflict: string }).conflict = "overwrite";
    }).toThrow();
  });

  it("keeps plan and action ids stable across clocks and object key insertion order", () => {
    const first = createMigrationPlan(base());
    const policy = { secrets: "redact", conflict: "merge" } as const;
    const second = createMigrationPlan(base({ createdAt: "2030-01-01T00:00:00Z", policy }));
    expect(second.planId).toBe(first.planId);
    expect(second.actions[0]?.actionId).toBe(first.actions[0]?.actionId);
  });

  it("changes domain-separated identities and plan ids for semantic changes", () => {
    const first = createMigrationPlan(base());
    const identities = createMigrationPlan(
      base({ sourceIdentity: "different-source", destinationIdentity: "different-destination" }),
    );
    expect(first.source.fingerprint).not.toBe(first.destination.fingerprint);
    expect(identities.planId).not.toBe(first.planId);
    const changed = createMigrationPlan(
      base({
        actions: [{ provider: "codex", resource: "configuration", disposition: "create" }],
      }),
    );
    expect(changed.actions[0]?.actionId).not.toBe(first.actions[0]?.actionId);
    expect(diffMigrationPlans(first, changed)).toEqual({
      changed: true,
      added: [changed.actions[0]?.actionId],
      removed: [first.actions[0]?.actionId],
    });
  });

  it("derives blocked and noop status without a delete disposition", () => {
    const blocked = createMigrationPlan(
      base({
        actions: [
          {
            provider: "shared",
            resource: "skills",
            disposition: "skip",
            preconditions: [{ code: "compatible", satisfied: false }],
          },
        ],
      }),
    );
    expect(blocked.status).toBe("blocked");
    expect(JSON.stringify(blocked)).not.toContain('"delete"');
    expect(
      createMigrationPlan(
        base({ actions: [{ provider: "claude", resource: "settings", disposition: "skip" }] }),
      ).status,
    ).toBe("noop");
  });
});
