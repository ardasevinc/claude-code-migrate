import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ExecutionReceipt,
  executionReceiptEndpointRef,
  finishExecutionReceipt,
  startExecutionReceipt,
} from "../../src/core/execution-receipt.ts";
import type { InventoryEntry } from "../../src/core/inventory.ts";
import {
  claudeMcpManagedEntry,
  managedStateVerificationFingerprint,
} from "../../src/core/managed-state-verification.ts";
import { createMigrationPlan } from "../../src/core/migration-plan.ts";
import { verifyExecutionReceipt } from "../../src/core/receipt-verification.ts";
import type { SshSession } from "../../src/core/ssh-session.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import { runProcess } from "../../src/utils/process.ts";

function entry(path: string, contents: string): InventoryEntry {
  return {
    path,
    type: "file",
    mode: 0o644,
    size: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function plan(kind: "push" | "restore", providers: readonly ("claude" | "codex")[]) {
  return createMigrationPlan({
    kind,
    providers,
    executionModel: kind === "push" ? "remote-staged-overlay" : "local-staged-overlay",
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
}

async function terminalReceipt(
  context: ReturnType<typeof createRuntimeContext>,
  verification: Parameters<typeof startExecutionReceipt>[2]["verification"],
): Promise<ExecutionReceipt> {
  const migration = plan(
    verification.mode === "remote" ? "push" : "restore",
    verification.claudeMcp ? ["claude", "codex"] : ["codex"],
  );
  const started = await startExecutionReceipt(context, migration, { verification });
  return finishExecutionReceipt(context, started, {
    outcome: "succeeded",
    finishedAt: new Date("2026-07-13T00:00:00.001Z"),
    actions: started.actions.map((action) => ({ ...action, outcome: "succeeded" })),
    observedPostFingerprint: migration.stagedPostFingerprint,
    observedManagedStateFingerprint: verification.plannedFingerprint,
  });
}

describe("execution receipt drift verification", () => {
  it("verifies local managed state, then detects drift without exposing contents", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-receipt-verify-local-")));
    const home = join(root, "home");
    const state = join(root, "state");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex/config.toml"), "model = 'first'\n");
    const expected = managedStateVerificationFingerprint([
      entry("codex/config.toml", "model = 'first'\n"),
    ]);
    const context = createRuntimeContext({
      home,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      process: { cwd: () => home, env: { XDG_STATE_HOME: state } },
    });
    try {
      const receipt = await terminalReceipt(context, {
        mode: "local",
        endpointRef: executionReceiptEndpointRef("local", home),
        inventoryRoots: ["codex/config.toml"],
        claudeMcp: false,
        codexPluginList: false,
        beforeFingerprint: expected,
        plannedFingerprint: expected,
      });
      expect(await verifyExecutionReceipt(context, receipt)).toMatchObject({
        valid: true,
        status: "verified",
        expectedFingerprint: expected,
        observedFingerprint: expected,
      });

      await writeFile(join(home, ".codex/config.toml"), "secret = 'changed'\n");
      const drifted = await verifyExecutionReceipt(context, receipt);
      expect(drifted).toMatchObject({ valid: false, status: "drifted" });
      expect(JSON.stringify(drifted)).not.toContain("secret");
      expect(JSON.stringify(drifted)).not.toContain(home);

      const { verification: _, ...legacyFields } = receipt;
      const legacy = { ...legacyFields, schemaVersion: 1 as const };
      expect(await verifyExecutionReceipt(context, legacy)).toMatchObject({
        valid: false,
        status: "unavailable",
        reasonCode: "legacy-receipt",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores excluded nested state while detecting managed local drift", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-receipt-verify-excluded-")));
    const home = join(root, "home");
    await mkdir(join(home, ".codex/skills/demo/.git"), { recursive: true });
    await mkdir(join(home, ".codex/skills/.system/private"), { recursive: true });
    await writeFile(join(home, ".codex/skills/demo/SKILL.md"), "managed\n");
    await writeFile(join(home, ".codex/skills/demo/.git/config"), "ignored-one\n");
    await writeFile(join(home, ".codex/skills/.system/private/state"), "ignored-two\n");
    const expected = managedStateVerificationFingerprint([
      entry("codex/skills/demo/SKILL.md", "managed\n"),
    ]);
    const context = createRuntimeContext({
      home,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
    });
    try {
      const receipt = await terminalReceipt(context, {
        mode: "local",
        endpointRef: executionReceiptEndpointRef("local", home),
        inventoryRoots: ["codex/skills"],
        claudeMcp: false,
        codexPluginList: false,
        beforeFingerprint: expected,
        plannedFingerprint: expected,
      });
      expect(await verifyExecutionReceipt(context, receipt)).toMatchObject({ valid: true });
      await writeFile(join(home, ".codex/skills/demo/.git/config"), "ignored-changed\n");
      await writeFile(join(home, ".codex/skills/.system/private/state"), "ignored-changed\n");
      expect(await verifyExecutionReceipt(context, receipt)).toMatchObject({ valid: true });
      await writeFile(join(home, ".codex/skills/demo/SKILL.md"), "managed-changed\n");
      expect(await verifyExecutionReceipt(context, receipt)).toMatchObject({
        valid: false,
        status: "drifted",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the bound target and verifies remote inventory before closing SSH", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-receipt-verify-remote-")));
    const home = join(root, "home");
    const remoteHome = join(root, "remote");
    await mkdir(join(remoteHome, ".codex"), { recursive: true });
    await mkdir(home, { recursive: true });
    const contents = "model = 'remote'\n";
    const mcp = '{"mcpServers":{"demo":{"command":"demo"}}}\n';
    const codex = join(remoteHome, "bin/codex");
    const pluginScript = (available: string) =>
      `#!/bin/sh\nprintf '%s' '{"available":[{"pluginId":"${available}@market"}],"installed":[{"pluginId":"a@market"}]}'\n`;
    await mkdir(join(remoteHome, "bin"));
    await writeFile(codex, pluginScript("z"), { mode: 0o755 });
    await writeFile(join(remoteHome, ".codex/config.toml"), contents);
    await writeFile(join(remoteHome, ".claude.json"), mcp);
    const expected = managedStateVerificationFingerprint(
      [claudeMcpManagedEntry(Buffer.from(mcp)), entry("codex/config.toml", contents)],
      {
        status: "ok",
        installed: ["a@market"],
        available: ["z@market"],
      },
    );
    const context = createRuntimeContext({
      home,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
    });
    const host = "operator@example.com";
    let closed = 0;
    const createSession = async (): Promise<SshSession> => ({
      host,
      run: (command, options) =>
        runProcess("sh", ["-c", command], {
          ...options,
          env: {
            ...process.env,
            HOME: remoteHome,
            PATH: `${join(remoteHome, "bin")}:/usr/bin:/bin`,
          },
        }),
      upload: async () => {
        throw new Error("unexpected upload");
      },
      streamRsync: async () => {
        throw new Error("unexpected rsync");
      },
      close: async () => {
        closed += 1;
      },
    });
    try {
      const receipt = await terminalReceipt(context, {
        mode: "remote",
        endpointRef: executionReceiptEndpointRef("remote", host),
        inventoryRoots: ["claude/.mcp-config.json", "codex/config.toml"],
        claudeMcp: true,
        codexPluginList: true,
        beforeFingerprint: expected,
        plannedFingerprint: expected,
      });
      expect(await verifyExecutionReceipt(context, receipt)).toMatchObject({
        valid: false,
        reasonCode: "remote-target-required",
      });
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: "other@example.com" }),
      ).toMatchObject({ valid: false, reasonCode: "target-mismatch" });
      expect(closed).toBe(0);
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: true, status: "verified" });
      expect(closed).toBe(1);
      await writeFile(codex, pluginScript("y"), { mode: 0o755 });
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: true, status: "verified" });
      expect(closed).toBe(2);
      await writeFile(codex, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({
        valid: false,
        status: "unavailable",
        reasonCode: "plugin-state-unobserved",
      });
      expect(closed).toBe(3);
      await writeFile(codex, pluginScript("z"), { mode: 0o755 });
      await writeFile(
        join(remoteHome, ".claude.json"),
        '{"mcpServers":{"demo":{"command":"demo"}},"unmanaged":"changed"}\n',
      );
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: true, status: "verified" });
      expect(closed).toBe(4);
      await writeFile(join(remoteHome, ".claude.json"), "{broken\n");
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: false, status: "drifted" });
      expect(closed).toBe(5);
      await writeFile(join(remoteHome, ".claude.json"), '{"mcpServers":[]}\n');
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: false, status: "drifted" });
      expect(closed).toBe(6);
      await writeFile(join(remoteHome, ".claude.json"), "{}\n");
      expect(
        await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession }),
      ).toMatchObject({ valid: false, status: "drifted" });
      expect(closed).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes remote verification sessions and preserves probe plus cleanup failures", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-receipt-verify-cleanup-")));
    const home = join(root, "home");
    const remoteHome = join(root, "remote");
    await mkdir(join(remoteHome, ".codex"), { recursive: true });
    await mkdir(home, { recursive: true });
    const contents = "model = 'remote'\n";
    await writeFile(join(remoteHome, ".codex/config.toml"), contents);
    const expected = managedStateVerificationFingerprint([entry("codex/config.toml", contents)]);
    const context = createRuntimeContext({
      home,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
    });
    const host = "operator@example.com";
    const receipt = await terminalReceipt(context, {
      mode: "remote",
      endpointRef: executionReceiptEndpointRef("remote", host),
      inventoryRoots: ["codex/config.toml"],
      claudeMcp: false,
      codexPluginList: false,
      beforeFingerprint: expected,
      plannedFingerprint: expected,
    });
    const failures = [
      { probe: true, close: false },
      { probe: false, close: true },
      { probe: true, close: true },
    ] as const;
    try {
      for (const failure of failures) {
        let closes = 0;
        const createSession = async (): Promise<SshSession> => ({
          host,
          run: failure.probe
            ? async () => {
                throw new Error("probe failed");
              }
            : (command, options) =>
                runProcess("sh", ["-c", command], {
                  ...options,
                  env: { ...process.env, HOME: remoteHome },
                }),
          upload: async () => {
            throw new Error("unexpected upload");
          },
          streamRsync: async () => {
            throw new Error("unexpected rsync");
          },
          close: async () => {
            closes += 1;
            if (failure.close) throw new Error("close failed");
          },
        });
        let caught: unknown;
        try {
          await verifyExecutionReceipt(context, receipt, { remoteTarget: host }, { createSession });
        } catch (error) {
          caught = error;
        }
        expect(closes).toBe(1);
        expect(caught).toBeInstanceOf(Error);
        if (failure.probe && failure.close) {
          expect(caught).toBeInstanceOf(AggregateError);
          expect((caught as AggregateError).errors).toEqual([
            expect.objectContaining({ message: "probe failed" }),
            expect.objectContaining({ message: "close failed" }),
          ]);
        } else {
          expect((caught as Error).message).toBe(failure.probe ? "probe failed" : "close failed");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
