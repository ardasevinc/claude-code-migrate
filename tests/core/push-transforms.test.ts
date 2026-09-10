import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/core/migration-plan.ts";
import {
  observeRemotePushTarget,
  type PushTargetObservation,
} from "../../src/core/push-observation.ts";
import {
  derivePushObservationQueries,
  transformPushInputs,
} from "../../src/core/push-transforms.ts";
import { runProcess } from "../../src/utils/process.ts";

function observation(
  overrides: Partial<PushTargetObservation["facts"]> = {},
): PushTargetObservation {
  return {
    capabilities: { os: "Linux", arch: "x86_64", gui: false, commands: ["demo", "guard"] },
    inventory: [],
    pushStateFingerprint: fingerprint("test", {}),
    facts: {
      home: "/home/target",
      pathExistence: new Map(),
      commandPaths: new Map(),
      captures: new Map(),
      marketplacePayloads: new Map(),
      sharedSkillNames: [],
      codexPluginList: { status: "missing", installed: [], available: [] },
      ...overrides,
    },
  };
}

describe("pure push host transforms", () => {
  it("disables unavailable runtime plugins without blocking portable config", async () => {
    const result = await transformPushInputs(
      {
        codexConfig: Buffer.from(`model = "gpt-5"
[marketplaces.openai-primary-runtime]
source_type = "local"
source = "/Users/source/runtime"
[plugins."documents@openai-primary-runtime"]
enabled = true
`),
      },
      observation({ codexPluginList: { status: "ok", installed: [], available: [] } }),
    );
    const config = parse(Buffer.from(result.codexConfig ?? []).toString());
    expect(config.model).toBe("gpt-5");
    expect(config.marketplaces).toBeUndefined();
    expect(config.plugins).toEqual({ "documents@openai-primary-runtime": { enabled: false } });
    expect(result.pluginDesires).toEqual([]);
    expect(result.pluginDecisions[0]?.reason).toContain("unavailable on the target");
  });

  it("keeps working target runtime registrations at their native paths", async () => {
    const config = `[marketplaces.openai-bundled]
source_type = "local"
source = "/home/target/.codex/.tmp/bundled-marketplaces/openai-bundled"
[plugins."browser@openai-bundled"]
enabled = true
`;
    const result = await transformPushInputs(
      { codexConfig: Buffer.from(config.replace("/home/target/", "/Users/source/")) },
      observation({
        captures: new Map([["codex-config", Buffer.from(config)]]),
        marketplacePayloads: new Map([["openai-bundled", true]]),
        codexPluginList: { status: "ok", installed: [], available: ["browser@openai-bundled"] },
      }),
    );
    expect(Buffer.from(result.codexConfig ?? []).toString()).toContain(
      "/home/target/.codex/.tmp/bundled-marketplaces/openai-bundled",
    );
    expect(result.pluginDesires).toEqual(["browser@openai-bundled"]);
    expect(result.warnings).toEqual([]);
  });

  it("maps legacy curated IDs only when the target confirms their replacements", async () => {
    const result = await transformPushInputs(
      {
        codexConfig: Buffer.from(`[plugins."build-web-apps@openai-curated"]
enabled = true
[plugins."test-android-apps@openai-curated"]
enabled = true
`),
      },
      observation({
        codexPluginList: {
          status: "ok",
          installed: [],
          available: [
            "build-web-apps@openai-curated-remote",
            "test-android-apps@openai-curated-remote",
          ],
        },
      }),
    );
    expect(result.pluginDesires).toEqual(["build-web-apps@openai-curated-remote"]);
    expect(result.pluginDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "build-web-apps@openai-curated-remote",
          sourcePluginId: "build-web-apps@openai-curated",
        }),
        expect.objectContaining({
          pluginId: "test-android-apps@openai-curated-remote",
          enabled: false,
          reason: "missing command adb",
        }),
      ]),
    );
  });

  it("honors explicit runtime requirements and target preserve policies", async () => {
    const id = "documents@openai-primary-runtime";
    const config = `[plugins."${id}"]\nenabled = true\n`;
    const target = observation({
      captures: new Map([["codex-config", Buffer.from(config)]]),
      codexPluginList: { status: "ok", installed: [], available: [] },
    });
    const required = await transformPushInputs({ codexConfig: Buffer.from(config) }, target, {
      [id]: { mode: "always" },
    });
    expect(required.pluginDesires).toEqual([id]);
    const preserved = await transformPushInputs({ codexConfig: Buffer.from(config) }, target, {
      [id]: { mode: "preserve" },
    });
    expect(preserved.pluginDesires).toEqual([]);
    expect(preserved.pluginDecisions[0]).toMatchObject({ enabled: true, action: "preserve" });
  });

  it("does not mistake a failed observation for unavailable runtime plugins", async () => {
    const id = "documents@openai-primary-runtime";
    const result = await transformPushInputs(
      { codexConfig: Buffer.from(`[plugins."${id}"]\nenabled = true\n`) },
      observation(),
    );
    expect(result.pluginDesires).toEqual([id]);
  });

  it("rejects conflicting legacy and current settings before effects", async () => {
    await expect(
      transformPushInputs(
        {
          codexConfig: Buffer.from(
            `[plugins."demo@openai-curated"]\nenabled = true\n[plugins."demo@openai-curated-remote"]\nenabled = false\n`,
          ),
        },
        observation({
          codexPluginList: {
            status: "ok",
            installed: [],
            available: ["demo@openai-curated-remote"],
          },
        }),
      ),
    ).rejects.toThrow("Conflicting plugin settings");
  });

  it("derives complete logical captures and command queries before probing", () => {
    const queries = derivePushObservationQueries(
      {
        claudeMcp: Buffer.from('{"mcpServers":{}}'),
        codexConfig: Buffer.from(`notify = ["/Users/source/notify"]
[marketplaces.local]
source_type = "local"
source = "/Users/source/market"
[mcp_servers.demo]
command = "/Users/source/demo"
`),
        codexHooks: Buffer.from(
          JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "/opt/guard" }] }] },
          }),
        ),
      },
      { "plugin@market": { mode: "auto", commands: ["special"] } },
    );
    expect(queries.captureIds).toEqual(["claude-mcp", "codex-config"]);
    expect(queries.pathExistence).toEqual(["/Users/source/demo", "/Users/source/notify"]);
    expect(queries.commandNames).toEqual(expect.arrayContaining(["demo", "guard", "special"]));
    expect(queries.marketplaceNames).toEqual(["local"]);
    expect(queries.codexPluginList).toBe(true);
  });

  it("merges MCP strictly and adapts config, marketplaces, hooks, and trust from facts", async () => {
    const config = `notify = ["/Users/source/missing"]
[marketplaces.local]
source_type = "local"
source = "/Users/source/market"
[mcp_servers.demo]
command = "/Users/source/demo"
[hooks.state."/Users/source/.codex/hooks.json:stop:0:0"]
enabled = true
trusted_hash = "sha256:source"
`;
    const result = await transformPushInputs(
      {
        claudeMcp: Buffer.from('{"mcpServers":{"new":{"command":"new"}}}'),
        codexConfig: Buffer.from(config),
        codexHooks: Buffer.from(
          JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "/opt/guard" }] }] },
          }),
        ),
      },
      observation({
        captures: new Map([
          ["claude-mcp", Buffer.from('{"theme":"dark","mcpServers":{"old":{}}}')],
        ]),
        commandPaths: new Map([
          ["demo", "/usr/bin/demo"],
          ["guard", "/usr/local/bin/guard"],
        ]),
        pathExistence: new Map([
          ["/Users/source/missing", false],
          ["/Users/source/demo", false],
        ]),
        marketplacePayloads: new Map([["local", true]]),
      }),
    );
    expect(JSON.parse(Buffer.from(result.claudeMcp ?? []).toString())).toMatchObject({
      theme: "dark",
      mcpServers: { old: {}, new: { command: "new" } },
    });
    const next = Buffer.from(result.codexConfig ?? []).toString();
    expect(next).toContain('command = "/usr/bin/demo"');
    expect(next).toContain('source = "/home/target/.codex/.ccm/marketplaces/local"');
    expect(next).not.toContain("trusted_hash");
    expect(next).not.toContain("notify =");
    expect(Buffer.from(result.codexHooks ?? []).toString()).toContain("/usr/local/bin/guard");
  });

  it("reports missing commands and applies preserve policy from captured target config", async () => {
    const result = await transformPushInputs(
      {
        codexConfig: Buffer.from(
          `[mcp_servers.gone]\ncommand = "/Users/source/gone"\n[plugins.demo]\nenabled = true\n`,
        ),
      },
      observation({
        commandPaths: new Map([["gone", null]]),
        pathExistence: new Map([["/Users/source/gone", false]]),
        captures: new Map([["codex-config", Buffer.from("[plugins.demo]\nenabled = false\n")]]),
      }),
      { demo: { mode: "preserve" } },
    );
    expect(result.warnings).toContain("gone: gone not found on remote");
    expect(Buffer.from(result.codexConfig ?? []).toString()).toContain("enabled = false");
    expect(result.pluginDecisions[0]).toMatchObject({
      pluginId: "demo",
      action: "preserve",
      enabled: false,
    });
    expect(result.pluginDesires).toEqual([]);
  });

  it("rejects duplicate keys in captured remote MCP without effects", async () => {
    await expect(
      transformPushInputs(
        { claudeMcp: Buffer.from('{"mcpServers":{}}') },
        observation({
          captures: new Map([["claude-mcp", Buffer.from('{"mcpServers":{},"mcpServers":{}}')]]),
        }),
      ),
    ).rejects.toThrow("Duplicate JSON object key");
  });

  it("derives and observes HOME paths without trusting an unknown remote cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-push-transform-observe-"));
    const bin = join(home, ".bun", "bin");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "demo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(home, ".codex", "config.toml"), "");
    const config = Buffer.from(`notify = ["../notify"]
[mcp_servers.home]
command = "~/.bun/bin/demo"
[mcp_servers.relative]
command = "./scripts/gone"
`);
    const queries = derivePushObservationQueries({ codexConfig: config });
    expect(queries.pathExistence).toEqual(["~/.bun/bin/demo"]);
    expect(queries.pathExistence).not.toContain("./scripts/gone");
    const observed = await observeRemotePushTarget({
      host: "test-host",
      incoming: [],
      queries,
      transport: {
        async run(_host, argvCommand, options) {
          return runProcess("/bin/sh", ["-c", argvCommand], {
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            maxBuffer: options.maxBuffer,
            timeoutMs: options.timeout,
          });
        },
      },
    });
    const resolvedDemo = await realpath(join(bin, "demo"));
    expect(observed.facts.commandPaths.get("demo")).toBe(resolvedDemo);
    expect(observed.facts.pathExistence.get("~/.bun/bin/demo")).toBe(true);
    const transformed = await transformPushInputs({ codexConfig: config }, observed);
    const output = Buffer.from(transformed.codexConfig ?? []).toString();
    expect(output).toContain(`command = ${JSON.stringify(resolvedDemo)}`);
    expect(output).not.toContain("mcp_servers.relative");
    expect(output).not.toContain("notify =");
  });

  it("is deterministic and does not mutate input bytes or observed facts", async () => {
    const config = Buffer.from(`[mcp_servers.demo]\ncommand = "/Users/source/demo"\n`);
    const original = Buffer.from(config);
    const facts = observation({
      commandPaths: new Map([["demo", "/usr/bin/demo"]]),
      pathExistence: new Map([["/Users/source/demo", false]]),
    });
    const commandsBefore = [...facts.facts.commandPaths];
    const first = await transformPushInputs({ codexConfig: config }, facts);
    const second = await transformPushInputs({ codexConfig: config }, facts);
    expect(first).toEqual(second);
    expect(config).toEqual(original);
    expect([...facts.facts.commandPaths]).toEqual(commandsBefore);
  });
});
