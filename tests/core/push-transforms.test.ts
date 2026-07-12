import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/core/migration-plan.ts";
import type { PushTargetObservation } from "../../src/core/push-observation.ts";
import {
  derivePushObservationQueries,
  transformPushInputs,
} from "../../src/core/push-transforms.ts";

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
      ...overrides,
    },
  };
}

describe("pure push host transforms", () => {
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
});
