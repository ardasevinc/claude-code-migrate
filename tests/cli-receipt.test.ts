import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executionReceiptEndpointRef,
  finishExecutionReceipt,
  startExecutionReceipt,
} from "../src/core/execution-receipt.ts";
import { managedStateVerificationFingerprint } from "../src/core/managed-state-verification.ts";
import { createMigrationPlan } from "../src/core/migration-plan.ts";
import { createRuntimeContext } from "../src/runtime/context.ts";
import { runCcm } from "./integration/harness/index.ts";

describe("receipt operator commands", () => {
  it("inspects and verifies a local receipt as one redacted JSON object", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "ccm-cli-receipt-")));
    const state = join(home, ".ccm-test-xdg/state");
    await mkdir(join(home, ".codex"), { recursive: true });
    const contents = "model = 'tuff'\n";
    await writeFile(join(home, ".codex/config.toml"), contents);
    const inventory = [
      {
        path: "codex/config.toml",
        type: "file" as const,
        mode: 0o644 as const,
        size: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    ];
    const expected = managedStateVerificationFingerprint(inventory);
    const context = createRuntimeContext({
      home,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      process: { cwd: () => home, env: { XDG_STATE_HOME: state } },
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
      ],
      dependencies: [],
      warnings: [],
      policies: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    try {
      const started = await startExecutionReceipt(context, plan, {
        verification: {
          mode: "local",
          endpointRef: executionReceiptEndpointRef("local", home),
          inventoryRoots: ["codex/config.toml"],
          claudeMcp: false,
          codexPluginList: false,
          beforeFingerprint: expected,
          plannedFingerprint: expected,
        },
      });
      const startedInspection = await runCcm(["inspect", started.id, "--json"], home);
      expect(JSON.parse(startedInspection.stdout)).toMatchObject({
        receipt: {
          outcome: "started",
          verification: { available: false, reasonCode: "execution-not-terminal" },
        },
      });
      const startedHuman = await runCcm(["inspect", started.id], home);
      expect(startedHuman).toMatchObject({ exitCode: 0, stderr: "" });
      expect(startedHuman.stdout).toContain(
        "Drift verification: unavailable (execution-not-terminal)",
      );
      await finishExecutionReceipt(context, started, {
        outcome: "succeeded",
        finishedAt: new Date("2026-07-13T00:00:00.001Z"),
        actions: started.actions.map((action) => ({ ...action, outcome: "succeeded" })),
        observedPostFingerprint: plan.stagedPostFingerprint,
        observedManagedStateFingerprint: expected,
      });

      const unobserved = await startExecutionReceipt(context, plan, {
        verification: {
          mode: "local",
          endpointRef: executionReceiptEndpointRef("local", home),
          inventoryRoots: ["codex/config.toml"],
          claudeMcp: false,
          codexPluginList: false,
          beforeFingerprint: expected,
          plannedFingerprint: expected,
        },
      });
      await finishExecutionReceipt(context, unobserved, {
        outcome: "failed",
        finishedAt: new Date("2026-07-13T00:00:00.001Z"),
      });
      const unobservedInspection = await runCcm(["inspect", unobserved.id, "--json"], home);
      expect(JSON.parse(unobservedInspection.stdout)).toMatchObject({
        receipt: {
          outcome: "failed",
          verification: { available: false, reasonCode: "terminal-state-unobserved" },
        },
      });

      const inspected = await runCcm(["inspect", started.id, "--json"], home);
      expect(inspected).toMatchObject({ exitCode: 0, stderr: "" });
      expect(inspected.stdout.trim().split("\n")).toHaveLength(1);
      expect(inspected.stdout).not.toContain(contents);
      expect(inspected.stdout).not.toContain(home);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        kind: "execution-receipt",
        receipt: { id: started.id, outcome: "succeeded", verification: { available: true } },
      });
      const invalidInspect = await runCcm(["inspect", started.id, "--files", "--json"], home);
      expect(invalidInspect).toMatchObject({ exitCode: 2, stderr: "" });
      expect(invalidInspect.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(invalidInspect.stdout)).toMatchObject({
        kind: "receipt-error",
        operation: "inspect",
        error: { code: "invalid-request", exitCode: 2 },
      });

      const verified = await runCcm(["verify", started.id, "--json"], home);
      expect(verified).toMatchObject({ exitCode: 0, stderr: "" });
      expect(verified.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        kind: "receipt-verification",
        valid: true,
        status: "verified",
      });

      await writeFile(join(home, ".codex/config.toml"), "private = 'drift'\n");
      const drifted = await runCcm(["verify", started.id, "--json"], home);
      expect(drifted).toMatchObject({ exitCode: 1, stderr: "" });
      expect(drifted.stdout.trim().split("\n")).toHaveLength(1);
      expect(drifted.stdout).not.toContain("private");
      expect(JSON.parse(drifted.stdout)).toMatchObject({ valid: false, status: "drifted" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
