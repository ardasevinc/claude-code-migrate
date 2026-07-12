import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createMigrationPlan,
  deriveActionId,
  diffMigrationPlans,
  fingerprint,
  type MigrationPlanInput,
} from "../../src/core/migration-plan.ts";

const fp = (value: string) => fingerprint("test", value);
const action = {
  operation: "overlay",
  disposition: "update",
  phase: "commit",
  scope: "codex",
  targetRef: "codex/config",
  sourceRef: "archive/codex/config",
  beforeFingerprint: fp("before"),
  afterFingerprint: fp("after"),
  reversibility: "reversible",
  policyProvenance: ["conflict.merge"],
} as const;
const base = (overrides: Partial<MigrationPlanInput> = {}): MigrationPlanInput => ({
  kind: "push",
  providers: ["claude", "codex"],
  profile: "portable",
  executionModel: "staged-v1",
  sourceEndpointRef: "endpoint_0123456789abcdef0123456789abcdef",
  targetEndpointRef: "endpoint_fedcba9876543210fedcba9876543210",
  sourceFingerprint: fp("source"),
  targetFingerprint: fp("target"),
  stagedPostFingerprint: fp("post"),
  preconditions: [
    { id: "target-writable", required: true, status: "satisfied", reasonCode: "target.writable" },
  ],
  actions: [action],
  dependencies: [],
  warnings: [{ code: "content.changed" }],
  policies: [{ code: "conflict", valueCode: "merge", provenance: "cli" }],
  createdAt: "2026-07-12T12:00:00Z",
  ...overrides,
});

describe("migration plan contract", () => {
  it("canonicalizes, redacts and freezes", () => {
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
    const plan = createMigrationPlan(base());
    expect(JSON.stringify(plan)).not.toContain("example.com");
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(plan.schemaVersion).toBe(1);
  });

  it("keeps ids deterministic with action identity independent of mutable planning results", () => {
    const first = createMigrationPlan(base());
    const changed = createMigrationPlan(
      base({
        createdAt: "2030-01-01T00:00:00Z",
        warnings: [],
        actions: [{ ...action, disposition: "merge", beforeFingerprint: fp("drift") }],
      }),
    );
    expect(changed.actions[0]?.id).toBe(first.actions[0]?.id);
    expect(changed.id).not.toBe(first.id);
    expect(diffMigrationPlans(first, changed)).toEqual({
      changed: true,
      added: [],
      removed: [],
      changedActions: [first.actions[0]?.id],
    });
    expect(deriveActionId(action)).toBe(first.actions[0]?.id);
  });

  it("canonicalizes unordered plan collections without changing authoritative action order", () => {
    const secondAction = { ...action, targetRef: "codex/second" } as const;
    const thirdAction = { ...action, targetRef: "codex/third" } as const;
    const firstId = deriveActionId(action);
    const unordered = base({
      providers: ["codex", "claude"],
      preconditions: [
        { id: "z-ready", required: false, status: "unknown", reasonCode: "state.unknown" },
        { id: "a-ready", required: true, status: "satisfied", reasonCode: "state.ready" },
      ],
      warnings: [{ code: "z.warning" }, { code: "a.warning" }],
      policies: [
        { code: "z-policy", valueCode: "preserve", provenance: "default" },
        { code: "a-policy", valueCode: "merge", provenance: "cli" },
      ],
      actions: [action, secondAction, thirdAction],
      dependencies: [
        {
          id: "z-dependency",
          ownerActionId: deriveActionId(thirdAction),
          dependsOnActionId: firstId,
          type: "ordering",
          required: true,
          status: "satisfied",
          resolution: "resolved",
        },
        {
          id: "a-dependency",
          ownerActionId: deriveActionId(secondAction),
          dependsOnActionId: firstId,
          type: "data",
          required: true,
          status: "satisfied",
          resolution: "resolved",
        },
      ],
    });
    const reordered = base({
      ...unordered,
      providers: [...unordered.providers].reverse(),
      preconditions: [...unordered.preconditions].reverse(),
      warnings: [...unordered.warnings].reverse(),
      policies: [...unordered.policies].reverse(),
      dependencies: [...unordered.dependencies].reverse(),
    });
    expect(createMigrationPlan(unordered).id).toBe(createMigrationPlan(reordered).id);
  });

  it("rejects raw or guessable endpoint identities and arbitrary policy payloads", () => {
    expect(() =>
      createMigrationPlan(base({ sourceEndpointRef: "endpoint_source-host-canary.example.com" })),
    ).toThrow("source endpoint ref");
    expect(() =>
      createMigrationPlan(base({ targetEndpointRef: "endpoint_ssh://user:secret@host" })),
    ).toThrow("target endpoint ref");
    expect(() =>
      createMigrationPlan(
        base({
          policies: [{ code: "conflict", valueCode: "raw secret value!", provenance: "cli" }],
        }),
      ),
    ).toThrow("policy value code");
  });

  it("derives blocked and noop only from binding readiness rules", () => {
    expect(
      createMigrationPlan(
        base({
          preconditions: [
            { id: "reachable", required: true, status: "unknown", reasonCode: "target.unknown" },
          ],
        }),
      ).status,
    ).toBe("blocked");
    expect(
      createMigrationPlan(base({ actions: [{ ...action, disposition: "preserve" }] })).status,
    ).toBe("noop");
  });

  it("validates duplicate, unknown, self, cyclic dependencies and symbolic values", () => {
    expect(() => createMigrationPlan(base({ actions: [action, action] }))).toThrow(
      "duplicate action",
    );
    expect(() => createMigrationPlan(base({ warnings: [{ code: "free form message!" }] }))).toThrow(
      "safe symbolic",
    );
    const one = createMigrationPlan(base()).actions[0]?.id;
    if (!one) throw new Error("missing test action");
    expect(() =>
      createMigrationPlan(
        base({
          dependencies: [
            {
              id: "missing-owner",
              ownerActionId: one,
              dependsOnActionId: "action_missing",
              type: "ordering",
              required: true,
              status: "unknown",
              resolution: "unresolved",
            },
          ],
        }),
      ),
    ).toThrow("unknown action");
    expect(() =>
      createMigrationPlan(
        base({
          dependencies: [
            {
              id: "self",
              ownerActionId: one,
              dependsOnActionId: one,
              type: "ordering",
              required: true,
              status: "satisfied",
              resolution: "resolved",
            },
          ],
        }),
      ),
    ).toThrow("self-referential");
    const secondInput = { ...action, targetRef: "codex/other" };
    const second = createMigrationPlan(base({ actions: [secondInput] })).actions[0]?.id;
    if (!second) throw new Error("missing second test action");
    expect(() =>
      createMigrationPlan(
        base({
          actions: [action, secondInput],
          dependencies: [
            {
              id: "one-two",
              ownerActionId: one,
              dependsOnActionId: second,
              type: "data",
              required: true,
              status: "satisfied",
              resolution: "resolved",
            },
            {
              id: "two-one",
              ownerActionId: second,
              dependsOnActionId: one,
              type: "data",
              required: true,
              status: "satisfied",
              resolution: "resolved",
            },
          ],
        }),
      ),
    ).toThrow("cyclic");
  });
});
