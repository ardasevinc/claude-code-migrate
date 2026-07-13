import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishExecutionReceipt,
  readExecutionReceipt,
  startExecutionReceipt,
} from "../../src/core/execution-receipt.ts";
import { createMigrationPlan } from "../../src/core/migration-plan.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-receipt-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  let now = Date.parse("2026-07-13T00:00:00.000Z");
  const context = createRuntimeContext({
    home,
    now: () => new Date(now++),
    process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
  });
  const plan = createMigrationPlan({
    kind: "restore",
    providers: ["codex"],
    executionModel: "local-staged-overlay",
    sourceEndpointRef: `endpoint_${"1".repeat(64)}`,
    targetEndpointRef: `endpoint_${"2".repeat(64)}`,
    sourceFingerprint: `fp_${"3".repeat(64)}`,
    targetFingerprint: `fp_${"4".repeat(64)}`,
    stagedPostFingerprint: `fp_${"5".repeat(64)}`,
    preconditions: [],
    actions: [
      {
        operation: "overlay",
        disposition: "update",
        phase: "commit",
        scope: "codex",
        targetRef: "sealed-target",
        reversibility: "reversible",
        policyProvenance: ["test"],
      },
      {
        operation: "overlay",
        disposition: "unchanged",
        phase: "commit",
        scope: "codex",
        targetRef: "sealed-unchanged-target",
        reversibility: "reversible",
        policyProvenance: ["test"],
      },
    ],
    dependencies: [],
    warnings: [{ code: "legacy-warning" }],
    policies: [],
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  const verification = {
    mode: "local" as const,
    endpointRef: `endpoint_${"6".repeat(64)}`,
    inventoryRoots: ["codex/config.toml"],
    claudeMcp: false,
    codexPluginList: false,
    beforeFingerprint: `fp_${"7".repeat(64)}`,
    plannedFingerprint: `fp_${"8".repeat(64)}`,
  };
  return { root, context, plan, verification };
}

describe("execution receipts", () => {
  it("durably publishes a private started receipt and a revisioned terminal receipt", async () => {
    const state = await fixture();
    try {
      const started = await startExecutionReceipt(state.context, state.plan, {
        verification: state.verification,
      });
      expect(started.outcome).toBe("started");
      expect((await lstat(join(state.root, "state/ccm/receipts"))).mode & 0o777).toBe(0o700);
      const path = join(state.root, "state/ccm/receipts", `${started.id}.json`);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(await readExecutionReceipt(state.context, started.id)).toEqual(started);

      const terminal = await finishExecutionReceipt(state.context, started, {
        outcome: "succeeded",
        finishedAt: new Date("2026-07-13T00:00:00.010Z"),
        actions: started.actions.map((action) => ({
          ...action,
          outcome: action.outcome === "skipped" ? "skipped" : "succeeded",
        })),
        observedPostFingerprint: state.plan.stagedPostFingerprint,
        observedManagedStateFingerprint: state.verification.plannedFingerprint,
        transferredBytes: 1024,
        reusedBytes: 256,
      });

      expect(terminal).toMatchObject({
        revision: 1,
        outcome: "succeeded",
        durationMs: 10,
        transport: { transferredBytes: 1024, reusedBytes: 256 },
      });
      expect(await readExecutionReceipt(state.context, started.id)).toEqual(terminal);
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain(state.root);
      expect(raw).not.toContain("sealed-target");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects stale terminal publication and strict-schema tampering", async () => {
    const state = await fixture();
    try {
      const started = await startExecutionReceipt(state.context, state.plan, {
        verification: state.verification,
      });
      const finish = {
        outcome: "failed" as const,
        finishedAt: new Date("2026-07-13T00:00:00.010Z"),
      };
      await expect(
        finishExecutionReceipt(state.context, started, {
          outcome: "succeeded",
          finishedAt: new Date("2026-07-13T00:00:00.010Z"),
          observedPostFingerprint: state.plan.stagedPostFingerprint,
          observedManagedStateFingerprint: state.verification.plannedFingerprint,
          actions: started.actions.map((action) => ({
            ...action,
            outcome: action.outcome === "pending" ? ("skipped" as const) : ("succeeded" as const),
          })),
        }),
      ).rejects.toThrow("action outcome");
      await expect(
        finishExecutionReceipt(
          state.context,
          { ...started, planId: `plan_${"9".repeat(64)}` },
          finish,
        ),
      ).rejects.toThrow("valid successor");
      await expect(
        finishExecutionReceipt(
          state.context,
          {
            ...started,
            verification: {
              ...(started.verification as NonNullable<typeof started.verification>),
              inventoryRoots: ["codex/hooks.json"],
            },
          },
          finish,
        ),
      ).rejects.toThrow("valid successor");
      await expect(
        finishExecutionReceipt(state.context, started, {
          outcome: "succeeded",
          finishedAt: new Date("2026-07-13T00:00:00.010Z"),
          observedPostFingerprint: state.plan.stagedPostFingerprint,
          actions: started.actions.map((action) => ({
            ...action,
            outcome: action.outcome === "pending" ? ("succeeded" as const) : action.outcome,
          })),
        }),
      ).rejects.toThrow("verification does not match");
      await expect(
        finishExecutionReceipt(state.context, started, {
          ...finish,
          actions: started.actions.map((action) => ({
            ...action,
            outcome: action.outcome === "pending" ? ("unknown" as const) : action.outcome,
          })),
        }),
      ).rejects.toThrow("Only recovery-required receipts");
      const failed = await finishExecutionReceipt(state.context, started, finish);
      expect(failed.actions.every((action) => action.outcome === "skipped")).toBe(true);
      await expect(finishExecutionReceipt(state.context, started, finish)).rejects.toThrow(
        "changed concurrently",
      );
      const path = join(state.root, "state/ccm/receipts", `${started.id}.json`);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, `${JSON.stringify({ ...parsed, durationMs: 999_999 })}\n`, {
        mode: 0o600,
      });
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow("lifecycle");
      await writeFile(path, `${JSON.stringify({ ...parsed, secret: "leak" })}\n`, { mode: 0o600 });
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "unknown field",
      );
      await writeFile(path, `${JSON.stringify({ ...parsed, schemaVersion: 1 })}\n`, {
        mode: 0o600,
      });
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "Legacy execution receipt contains verification data",
      );
      await writeFile(
        path,
        `${JSON.stringify({
          ...parsed,
          verification: {
            ...(parsed.verification as Record<string, unknown>),
            inventoryRoots: ["/private/target"],
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "verification root is invalid",
      );
      await writeFile(
        path,
        `${JSON.stringify({
          ...parsed,
          verification: {
            ...(parsed.verification as Record<string, unknown>),
            inventoryRoots: ["codex/auth.json"],
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "verification root is unmanaged",
      );
      for (const root of ["codex", "claude", "shared/agents", "codex/.tmp"]) {
        await writeFile(
          path,
          `${JSON.stringify({
            ...parsed,
            verification: {
              ...(parsed.verification as Record<string, unknown>),
              inventoryRoots: [root],
            },
          })}\n`,
          { mode: 0o600 },
        );
        await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
          "verification root is unmanaged",
        );
      }
      await writeFile(
        path,
        `${JSON.stringify({
          ...parsed,
          providers: ["claude", "codex"],
          verification: {
            ...(parsed.verification as Record<string, unknown>),
            inventoryRoots: ["claude/.mcp-config.json", "codex/config.toml"],
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "Claude MCP verification scope is inconsistent",
      );
      await writeFile(
        path,
        `${JSON.stringify({
          ...parsed,
          verification: {
            ...(parsed.verification as Record<string, unknown>),
            codexPluginList: true,
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "verification is invalid",
      );
      await writeFile(path, `${JSON.stringify({ ...parsed, providers: ["claude"] })}\n`, {
        mode: 0o600,
      });
      await expect(readExecutionReceipt(state.context, started.id)).rejects.toThrow(
        "verification root is outside provider selection",
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("binds the embedded receipt identity to its requested filename", async () => {
    const state = await fixture();
    try {
      const started = await startExecutionReceipt(state.context, state.plan, {
        verification: state.verification,
      });
      const directory = join(state.root, "state/ccm/receipts");
      const copiedId = `rcpt_${"f".repeat(32)}`;
      await copyFile(join(directory, `${started.id}.json`), join(directory, `${copiedId}.json`));
      await expect(readExecutionReceipt(state.context, copiedId)).rejects.toThrow(
        "filename identity mismatch",
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("safely initializes a missing nested state home concurrently", async () => {
    const state = await fixture();
    try {
      const context = createRuntimeContext({
        home: state.context.home,
        now: state.context.now,
        process: {
          cwd: () => state.context.home,
          env: { XDG_STATE_HOME: join(state.root, "missing/nested/state") },
        },
      });
      const receipts = await Promise.all([
        startExecutionReceipt(context, state.plan, { verification: state.verification }),
        startExecutionReceipt(context, state.plan, { verification: state.verification }),
      ]);
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(2);
      await Promise.all(receipts.map((receipt) => readExecutionReceipt(context, receipt.id)));
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
