import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExecutionReceipt } from "../../src/core/execution-receipt.ts";
import { fingerprint } from "../../src/core/migration-plan.ts";
import {
  executePlannedPush,
  type PlanPushInput,
  planPush as rawPlanPush,
} from "../../src/core/plan-push.ts";
import {
  type PushTargetObservation,
  pushStateFingerprint,
} from "../../src/core/push-observation.ts";
import { preparePushObservationRequest } from "../../src/core/push-observation-request.ts";
import { ExecutionError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

async function receiptFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-push-receipt-")));
  const context = createRuntimeContext({
    home: root,
    process: { cwd: () => root, env: { XDG_STATE_HOME: join(root, "state") } },
  });
  return { root, context };
}

async function receipts(state: Awaited<ReturnType<typeof receiptFixture>>) {
  const directory = join(state.root, "state/ccm/receipts");
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readExecutionReceipt(state.context, name.slice(0, -5))),
  );
}

function observation(): PushTargetObservation {
  return {
    capabilities: { os: "Linux", arch: "x86_64", gui: false, commands: [] },
    inventory: [],
    pushStateFingerprint: fingerprint("push-test", {}),
    facts: {
      home: "/home/secret-target",
      pathExistence: new Map(),
      commandPaths: new Map(),
      captures: new Map(),
      marketplacePayloads: new Map(),
      sharedSkillNames: [],
      codexPluginList: { status: "ok", installed: [], available: [] },
    },
  };
}

async function planPush(input: Omit<PlanPushInput, "preparedRequest">) {
  const preparedRequest = await preparePushObservationRequest({
    host: input.host,
    files: input.files,
    providers: input.providers,
    policyOverrides: input.policyOverrides,
  });
  return rawPlanPush({
    ...input,
    preparedRequest,
    observation: { ...input.observation, requestIdentity: preparedRequest.requestIdentity },
  });
}

describe("push migration planning", () => {
  it("rejects an observation made for a different prepared request", async () => {
    const preparedRequest = await preparePushObservationRequest({
      host: "target",
      files: [],
      providers: ["codex"],
    });
    await expect(
      rawPlanPush({
        files: [],
        host: "target",
        providers: ["codex"],
        preparedRequest,
        observation: { ...observation(), requestIdentity: fingerprint("wrong-request", {}) },
      }),
    ).rejects.toThrow("prepared request");
  });

  it("rejects empty and mismatched provider selections", async () => {
    await expect(
      planPush({ files: [], host: "target", providers: [], observation: observation() }),
    ).rejects.toThrow("at least one provider");
    await expect(
      planPush({
        files: [
          {
            sourcePath: "/unused",
            relativePath: "claude/settings.json",
            isSymlink: false,
            mcpServersOnly: "{}",
          },
        ],
        host: "target",
        providers: ["codex"],
        observation: observation(),
      }),
    ).rejects.toThrow("outside provider selection");
  });

  it("seals resources and produces a deterministic ordered overlay", async () => {
    const input = {
      files: [
        {
          sourcePath: "/private/source/config.toml",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: "model = 'test'\n",
        },
      ],
      host: "secret-user@secret-host",
      providers: ["codex" as const],
      observation: observation(),
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const first = await planPush(input);
    const second = await planPush(input);

    expect(first.plan).toEqual(second.plan);
    expect(first.plan.actions.map((action) => action.phase)).toEqual(["materialize", "commit"]);
    expect(first.plan.stagedPostFingerprint).not.toBe(first.plan.targetFingerprint);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan)).toBe(true);
    const publicJson = JSON.stringify(first);
    expect(publicJson).not.toContain("/private/source");
    expect(publicJson).not.toContain("secret-user");
    expect(publicJson).not.toContain("secret-host");
    expect(publicJson).not.toContain("/home/secret-target");
    expect(publicJson).not.toContain("model =");
  });

  it("plans MCP merge, shared overlay, and symlink recreation in dependency order", async () => {
    const receiptState = await receiptFixture();
    const planned = await planPush({
      files: [
        {
          sourcePath: "/unused/mcp",
          relativePath: "claude/.mcp-config.json",
          isSymlink: false,
          mcpServersOnly: '{"mcpServers":{"new":{}}}',
        },
        {
          sourcePath: "/unused/skill",
          relativePath: "shared/agents/skills/demo/SKILL.md",
          isSymlink: false,
          mcpServersOnly: "demo",
        },
      ],
      host: "target",
      providers: ["claude"],
      observation: observation(),
    });
    expect(planned.plan.actions.map((action) => [action.phase, action.operation])).toEqual([
      ["materialize", "merge-json"],
      ["commit", "overlay"],
      ["commit", "overlay"],
      ["post-commit", "symlink"],
    ]);
    expect(planned.plan.dependencies.length).toBeGreaterThanOrEqual(3);
    expect(planned.plan.status).toBe("ready");
    const overlayIndex = planned.plan.actions.findIndex((action) =>
      action.policyProvenance.includes("no-delete-overlay.default"),
    );
    const mcpWriteIndex = planned.plan.actions.findIndex((action) =>
      action.policyProvenance.includes("atomic-file-write.default"),
    );
    expect(overlayIndex).toBeGreaterThanOrEqual(0);
    expect(mcpWriteIndex).toBeGreaterThan(overlayIndex);

    const bindingOrder: string[] = [];
    const requestIdentity = planned.plan.preconditions.find(
      (item) => item.id === "prepared-observation-scope",
    )?.expectedFingerprint;
    await expect(
      executePlannedPush(
        planned,
        {
          observe: async (request) => ({
            ...observation(),
            requestIdentity: request.requestIdentity ?? requestIdentity,
          }),
          prepare: async () => ({
            apply: async (_action, binding) => {
              bindingOrder.push(binding.kind);
              if (binding.kind === "write-claude-mcp") throw new Error("stop after MCP write");
            },
            commit: async () => {},
            applyEffect: async () => {},
            acknowledgeFailedEffects: async () => {},
            abort: async () => {},
            isCommitted: () => false,
            verifyCommit: async () => {},
            verifyRollback: async () => {},
            cleanup: async () => {},
          }),
        },
        { context: receiptState.context },
      ),
    ).rejects.toMatchObject({
      name: "ExecutionError",
      message: "Push execution failed after mutation started",
      cause: expect.objectContaining({ message: "stop after MCP write" }),
    });
    expect(bindingOrder.indexOf("overlay-group")).toBeGreaterThanOrEqual(0);
    expect(bindingOrder.indexOf("write-claude-mcp")).toBeGreaterThan(
      bindingOrder.indexOf("overlay-group"),
    );
    expect(await receipts(receiptState)).toMatchObject([
      {
        outcome: "rolled_back",
        observedPostFingerprint: planned.plan.targetFingerprint,
      },
    ]);
    await rm(receiptState.root, { recursive: true, force: true });
  });

  it("rejects a decision-byte race against the recollected source inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-push-decision-race-"));
    try {
      const sourcePath = join(root, "config.toml");
      await writeFile(sourcePath, "model = 'A'\n");
      const files = [{ sourcePath, relativePath: "codex/config.toml", isSymlink: false }];
      const preparedRequest = await preparePushObservationRequest({
        host: "target",
        files,
        providers: ["codex"],
      });
      await expect(
        rawPlanPush({
          files,
          host: "target",
          providers: ["codex"],
          preparedRequest,
          observation: { ...observation(), requestIdentity: preparedRequest.requestIdentity },
          afterDecisionCaptureTestHook: async () => writeFile(sourcePath, "model = 'B'\n"),
        }),
      ).rejects.toThrow("decision input changed while planning");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records measured transport bytes when preparation fails after transfer", async () => {
    const receiptState = await receiptFixture();
    try {
      const target = observation();
      const planned = await planPush({
        files: [
          {
            sourcePath: "/unused/config",
            relativePath: "codex/config.toml",
            isSymlink: false,
            mcpServersOnly: "model = 'test'\n",
          },
        ],
        host: "target",
        providers: ["codex"],
        observation: target,
      });
      let metrics = { transferredBytes: null as number | null, reusedBytes: null as number | null };
      await expect(
        executePlannedPush(
          planned,
          {
            observe: async (request) => ({ ...target, requestIdentity: request.requestIdentity }),
            transportMetrics: () => metrics,
            prepare: async () => {
              metrics = { transferredBytes: 12, reusedBytes: 3 };
              throw new Error("manifest upload failed");
            },
          },
          { context: receiptState.context },
        ),
      ).rejects.toThrow("manifest upload failed");
      expect(await receipts(receiptState)).toMatchObject([
        {
          outcome: "failed",
          transport: { transferredBytes: 12, reusedBytes: 3 },
        },
      ]);
    } finally {
      await rm(receiptState.root, { recursive: true, force: true });
    }
  });

  it("blocks unresolved plugin effects instead of degrading to noop", async () => {
    const base = observation();
    const target = {
      ...base,
      facts: {
        ...base.facts,
        codexPluginList: { status: "ok" as const, installed: [], available: [] },
      },
    };
    const planned = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: '[plugins."demo@market"]\nenabled = true\n',
        },
      ],
      host: "target",
      providers: ["codex"],
      observation: target,
    });
    expect(planned.plan.status).toBe("blocked");
    expect(planned.plan.preconditions).toContainEqual(
      expect.objectContaining({ id: "plugin-effects-resolved", status: "failed" }),
    );
  });

  it("executes a sealed plugin add and verifies the disjoint final plugin state", async () => {
    const successReceiptState = await receiptFixture();
    const failureReceiptState = await receiptFixture();
    const uncertainReceiptState = await receiptFixture();
    const config = Buffer.from('[plugins."demo@market"]\nenabled = true\n');
    const base = observation();
    const target = {
      ...base,
      capabilities: { ...base.capabilities, commands: ["codex"] },
      facts: {
        ...base.facts,
        commandPaths: new Map([["codex", "/usr/local/bin/codex"]]),
        codexPluginList: {
          status: "ok" as const,
          installed: [],
          available: ["demo@market"],
        },
      },
    };
    const planned = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: config.toString(),
        },
      ],
      host: "target",
      providers: ["codex"],
      configuredPolicyIds: ["demo@market"],
      observation: target,
    });
    expect(
      planned.plan.actions.find((action) => action.operation === "external-effect")
        ?.policyProvenance,
    ).toContain("plugin-policy.config");
    const profiled = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: config.toString(),
        },
      ],
      host: "target",
      providers: ["codex"],
      policyOverrides: { "demo@market": { mode: "always" } },
      profile: {
        name: "devbox",
        host: "target",
        configDir: "/unused",
        definition: {
          host: "target",
          codex: { plugin_policies: { "demo@market": { mode: "always" } } },
        },
        assets: [],
        effectCodes: new Map(),
        warnings: [],
        pluginPolicies: { "demo@market": { mode: "always" } },
      },
      observation: target,
    });
    expect(
      profiled.plan.actions.find((action) => action.operation === "external-effect")
        ?.policyProvenance,
    ).toContain("profile.devbox.plugin-policy");
    const finalEntry = {
      path: "codex/config.toml",
      type: "file" as const,
      mode: 0o644 as const,
      size: config.length,
      sha256: createHash("sha256").update(config).digest("hex"),
    };
    const pluginBindings: Array<{
      kind: "plugin-add";
      pluginId: string;
      codexCommand: string;
    }> = [];
    let observations = 0;
    await executePlannedPush(
      planned,
      {
        transportMetrics: () => ({ transferredBytes: 10, reusedBytes: 5 }),
        observe: async (request) => {
          observations += 1;
          if (observations === 1) return { ...target, requestIdentity: request.requestIdentity };
          if (observations === 2)
            return {
              ...target,
              inventory: [finalEntry],
              facts: { ...target.facts, captures: new Map([["codex-config", config]]) },
              requestIdentity: request.requestIdentity,
            };
          return {
            ...target,
            inventory: [finalEntry],
            facts: {
              ...target.facts,
              captures: new Map([["codex-config", config]]),
              codexPluginList: {
                status: "ok" as const,
                installed: ["demo@market"],
                available: [],
              },
            },
            requestIdentity: request.requestIdentity,
          };
        },
        prepare: async () => ({
          apply: async (_action, binding) => {
            if (binding.kind === "plugin-add") pluginBindings.push(binding);
          },
          commit: async () => {},
          applyEffect: async (_action, binding) => {
            if (binding.kind === "plugin-add") pluginBindings.push(binding);
          },
          acknowledgeFailedEffects: async () => {},
          abort: async () => {},
          isCommitted: () => false,
          verifyCommit: async () => {},
          verifyRollback: async () => {},
          cleanup: async () => {},
        }),
      },
      { context: successReceiptState.context },
    );
    expect(pluginBindings).toEqual([
      { kind: "plugin-add", pluginId: "demo@market", codexCommand: "/usr/local/bin/codex" },
    ]);
    expect(await receipts(successReceiptState)).toMatchObject([
      {
        outcome: "succeeded",
        observedPostFingerprint: planned.plan.stagedPostFingerprint,
        transport: { transferredBytes: 10, reusedBytes: 5 },
      },
    ]);

    const failedConfig = Buffer.from(
      '[plugins."demo-a@market"]\nenabled = true\n[plugins."demo-b@market"]\nenabled = true\n',
    );
    const failedEntry = {
      ...finalEntry,
      size: failedConfig.length,
      sha256: createHash("sha256").update(failedConfig).digest("hex"),
    };
    const failedTarget = {
      ...target,
      facts: {
        ...target.facts,
        codexPluginList: {
          status: "ok" as const,
          installed: [],
          available: ["demo-a@market", "demo-b@market"],
        },
      },
    };
    const partialTarget = {
      ...failedTarget,
      inventory: [failedEntry],
      facts: {
        ...failedTarget.facts,
        captures: new Map([["codex-config", failedConfig]]),
        codexPluginList: {
          status: "ok" as const,
          installed: ["demo-a@market"],
          available: ["demo-b@market"],
        },
      },
    };
    const failed = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: failedConfig.toString(),
        },
      ],
      host: "target",
      providers: ["codex"],
      configuredPolicyIds: ["demo-a@market", "demo-b@market"],
      observation: failedTarget,
    });
    let committed = false;
    let aborts = 0;
    let failedAcknowledgements = 0;
    let cleanups = 0;
    let failureObservations = 0;
    await expect(
      executePlannedPush(
        failed,
        {
          observe: async (request) => {
            failureObservations += 1;
            if (failureObservations === 1)
              return { ...failedTarget, requestIdentity: request.requestIdentity };
            if (failureObservations === 2)
              return {
                ...failedTarget,
                inventory: [failedEntry],
                facts: {
                  ...failedTarget.facts,
                  captures: new Map([["codex-config", failedConfig]]),
                },
                requestIdentity: request.requestIdentity,
              };
            return { ...partialTarget, requestIdentity: request.requestIdentity };
          },
          prepare: async () => ({
            apply: async () => {},
            commit: async () => {
              committed = true;
            },
            applyEffect: async (action) => {
              const plugin = failed.plan.actions.find((item) => item.id === action.id)?.targetRef;
              if (plugin === failed.plan.actions.at(-1)?.targetRef)
                throw new ExecutionError("committed_with_failed_effects");
            },
            acknowledgeFailedEffects: async () => {
              failedAcknowledgements += 1;
            },
            abort: async () => {
              aborts += 1;
            },
            isCommitted: () => committed,
            verifyCommit: async () => {},
            verifyRollback: async () => {},
            cleanup: async () => {
              cleanups += 1;
            },
          }),
        },
        { context: failureReceiptState.context },
      ),
    ).rejects.toMatchObject({ name: "ExecutionError", message: "committed_with_failed_effects" });
    expect({ aborts, cleanups, failedAcknowledgements }).toEqual({
      aborts: 0,
      cleanups: 1,
      failedAcknowledgements: 1,
    });
    expect(await receipts(failureReceiptState)).toMatchObject([
      {
        outcome: "committed_with_failed_effects",
        filesystemPostFingerprint: expect.stringMatching(/^fp_/),
        observedPostFingerprint: pushStateFingerprint(partialTarget),
        warnings: expect.arrayContaining(["committed-with-failed-effects"]),
        actions: expect.arrayContaining([
          expect.objectContaining({ operation: "external-effect", outcome: "succeeded" }),
          expect.objectContaining({ operation: "external-effect", outcome: "failed" }),
        ]),
      },
    ]);
    const uncertain = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: failedConfig.toString(),
        },
      ],
      host: "target",
      providers: ["codex"],
      configuredPolicyIds: ["demo-a@market", "demo-b@market"],
      observation: failedTarget,
    });
    let uncertainObservations = 0;
    let uncertainEffects = 0;
    await expect(
      executePlannedPush(
        uncertain,
        {
          observe: async (request) => {
            uncertainObservations += 1;
            return uncertainObservations === 1
              ? { ...failedTarget, requestIdentity: request.requestIdentity }
              : {
                  ...failedTarget,
                  inventory: [failedEntry],
                  facts: {
                    ...failedTarget.facts,
                    captures: new Map([["codex-config", failedConfig]]),
                  },
                  requestIdentity: request.requestIdentity,
                };
          },
          prepare: async () => ({
            apply: async () => {},
            commit: async () => {},
            applyEffect: async () => {
              uncertainEffects += 1;
              if (uncertainEffects === 2) throw new Error("effect transport lost");
            },
            acknowledgeFailedEffects: async () => {},
            abort: async () => {},
            isCommitted: () => true,
            verifyCommit: async () => {},
            verifyRollback: async () => {},
            cleanup: async () => {},
          }),
        },
        { context: uncertainReceiptState.context },
      ),
    ).rejects.toMatchObject({ message: "committed_effect_recovery_required" });
    expect(await receipts(uncertainReceiptState)).toMatchObject([
      {
        outcome: "recovery_required",
        actions: expect.arrayContaining([
          expect.objectContaining({ operation: "external-effect", outcome: "succeeded" }),
          expect.objectContaining({ operation: "external-effect", outcome: "unknown" }),
        ]),
      },
    ]);
    await Promise.all(
      [successReceiptState.root, failureReceiptState.root, uncertainReceiptState.root].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("executes sealed bindings exactly once and rejects forged plans", async () => {
    const bytes = Buffer.from("demo");
    const entry = {
      path: "shared/agents/skills/demo/SKILL.md",
      type: "file" as const,
      mode: 0o644 as const,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const base = observation();
    const target = {
      ...base,
      inventory: [entry],
      facts: { ...base.facts, sharedSkillNames: ["demo"] },
    };
    const planned = await planPush({
      files: [
        {
          sourcePath: "/unused/skill",
          relativePath: entry.path,
          isSymlink: false,
          mcpServersOnly: "demo",
        },
      ],
      host: "target",
      providers: ["codex"],
      observation: target,
    });
    const calls: string[] = [];
    const requests: unknown[] = [];
    const adapter = {
      observe: async (request: { requestIdentity: PushTargetObservation["requestIdentity"] }) => {
        requests.push(request);
        return { ...target, requestIdentity: request.requestIdentity };
      },
      prepare: async () => ({
        apply: async (action: (typeof planned.plan.actions)[number], binding: { kind: string }) => {
          calls.push(`${action.id}:${binding.kind}`);
        },
        commit: async () => {},
        applyEffect: async () => {},
        acknowledgeFailedEffects: async () => {},
        abort: async () => {},
        isCommitted: () => false,
        verifyCommit: async () => {},
        verifyRollback: async () => {},
        cleanup: async () => {},
      }),
    };
    await executePlannedPush(planned, adapter);
    expect(calls).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests)).toContain("shared/agents/skills");
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow("already consumed");
    await expect(executePlannedPush({ plan: planned.plan }, adapter)).rejects.toThrow("forged");
  });

  it("keeps the sealed plan retryable when remote preparation fails", async () => {
    const target = observation();
    const planned = await planPush({
      files: [
        {
          sourcePath: "/unused/config",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: "model = 'new'\n",
        },
      ],
      host: "target",
      providers: ["codex"],
      observation: target,
    });
    let preparations = 0;
    let failPreparation = true;
    let stagedPath: string | undefined;
    const adapter = {
      observe: async (request: { requestIdentity: PushTargetObservation["requestIdentity"] }) => ({
        ...target,
        requestIdentity: request.requestIdentity,
      }),
      prepare: async (input: { archivePath: string }) => {
        preparations += 1;
        stagedPath = input.archivePath;
        if (failPreparation) throw new Error("upload failed");
        return {
          apply: async () => {
            throw new Error("apply failed");
          },
          commit: async () => {},
          applyEffect: async () => {},
          acknowledgeFailedEffects: async () => {},
          abort: async () => {},
          isCommitted: () => false,
          verifyCommit: async () => {},
          verifyRollback: async () => {},
          cleanup: async () => {
            throw new Error("remote cleanup failed");
          },
        };
      },
    };
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow("upload failed");
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow("upload failed");
    expect(preparations).toBe(2);
    failPreparation = false;
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow(
      "Push failed with recovery or cleanup errors",
    );
    expect(await lstat(stagedPath as string).catch(() => null)).toBeNull();
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow("already consumed");
  });

  it("rechecks a physical noop source and keeps source-drift failure retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-push-noop-"));
    try {
      const sourcePath = join(root, "skill.md");
      await writeFile(sourcePath, "A");
      const entry = {
        path: "shared/agents/skills/demo/SKILL.md",
        type: "file" as const,
        mode: 0o644 as const,
        size: 1,
        sha256: createHash("sha256").update("A").digest("hex"),
      };
      const base = observation();
      const target = { ...base, inventory: [entry] };
      const planned = await planPush({
        files: [{ sourcePath, relativePath: entry.path, isSymlink: false }],
        host: "target",
        providers: ["codex"],
        observation: target,
      });
      expect(planned.plan.status).toBe("noop");
      let prepared = false;
      const adapter = {
        observe: async (request: {
          requestIdentity: PushTargetObservation["requestIdentity"];
        }) => ({
          ...target,
          requestIdentity: request.requestIdentity,
        }),
        prepare: async () => {
          prepared = true;
          throw new Error("noop must not prepare");
        },
      };
      await writeFile(sourcePath, "B");
      await expect(executePlannedPush(planned, adapter)).rejects.toThrow(
        "Push source changed after planning",
      );
      await writeFile(sourcePath, "A");
      await executePlannedPush(planned, adapter);
      expect(prepared).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
