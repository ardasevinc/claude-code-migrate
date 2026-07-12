import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/core/migration-plan.ts";
import {
  executePlannedPush,
  planPush as rawPlanPush,
  type PlanPushInput,
} from "../../src/core/plan-push.ts";
import { preparePushObservationRequest } from "../../src/core/push-observation-request.ts";
import type { PushTargetObservation } from "../../src/core/push-observation.ts";

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
      executePlannedPush(planned, {
        observe: async (request) => ({
          ...observation(),
          requestIdentity: request.requestIdentity ?? requestIdentity,
        }),
        prepare: async () => ({
          apply: async (_action, binding) => {
            bindingOrder.push(binding.kind);
            if (binding.kind === "write-claude-mcp") throw new Error("stop after MCP write");
          },
          cleanup: async () => {},
        }),
      }),
    ).rejects.toThrow("stop after MCP write");
    expect(bindingOrder.indexOf("overlay-group")).toBeGreaterThanOrEqual(0);
    expect(bindingOrder.indexOf("write-claude-mcp")).toBeGreaterThan(
      bindingOrder.indexOf("overlay-group"),
    );
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
      observation: target,
    });
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
    await executePlannedPush(planned, {
      observe: async (request) => {
        observations += 1;
        if (observations === 1) return { ...target, requestIdentity: request.requestIdentity };
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
        cleanup: async () => {},
      }),
    });
    expect(pluginBindings).toEqual([
      { kind: "plugin-add", pluginId: "demo@market", codexCommand: "/usr/local/bin/codex" },
    ]);
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
        cleanup: async () => {},
      }),
    };
    await executePlannedPush(planned, adapter);
    expect(calls).toEqual([]);
    expect(requests).toHaveLength(2);
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
    await expect(executePlannedPush(planned, adapter)).rejects.toThrow("apply failed");
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
