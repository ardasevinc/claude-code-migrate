import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";
import { fingerprint } from "../../src/core/migration-plan.ts";
import {
  deriveRestoreObservationQueries,
  mergeClaudeMcpStrict,
  transformRestoreInputs,
} from "../../src/core/restore-transforms.ts";

const missingMcp = {
  exists: false,
  fingerprint: fingerprint("test", { exists: false }),
} as const;

describe("restore transforms", () => {
  it("strictly merges Claude MCP bytes and preserves the full target document", () => {
    const merged = mergeClaudeMcpStrict(Buffer.from('{"mcpServers":{"new":{"command":"new"}}}'), {
      exists: true,
      bytes: Buffer.from('{"theme":"dark","mcpServers":{"old":{"command":"old"}}}'),
      fingerprint: fingerprint("test", { exists: true }),
    });
    expect(JSON.parse(Buffer.from(merged).toString())).toEqual({
      theme: "dark",
      mcpServers: { old: { command: "old" }, new: { command: "new" } },
    });
    expect(() => mergeClaudeMcpStrict(Buffer.from("{}"), missingMcp)).toThrow(
      "must contain an mcpServers object",
    );
  });

  it("derives all host queries before applying transforms", () => {
    const queries = deriveRestoreObservationQueries({
      codexConfig: Buffer.from(`notify = ["/Users/source/bin/notify"]
[marketplaces.local]
source_type = "local"
source = "/Users/source/market"
[mcp_servers.demo]
command = "/Users/source/bin/demo"
`),
      codexHooks: Buffer.from(
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "/Users/source/bin/guard" }] }] },
        }),
      ),
    });
    expect(queries.pathExistence).toEqual(["/Users/source/bin/demo", "/Users/source/bin/notify"]);
    expect(queries.hookCommands).toEqual(["/Users/source/bin/guard"]);
    expect(queries.marketplaceNames).toEqual(["local"]);
  });

  it("rewrites projected paths and resets hook trust from fixed observed facts", async () => {
    const paths = collectionPathsForHome("/home/target");
    const config = `[marketplaces.local]
source_type = "local"
source = "/Users/source/market"

[hooks.state."/Users/source/.codex/hooks.json:stop:0:0"]
enabled = true
trusted_hash = "sha256:not-reused"
`;
    const hooks = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/Users/source/bin/guard" }] }] },
    });
    const result = await transformRestoreInputs(
      { codexConfig: Buffer.from(config), codexHooks: Buffer.from(hooks) },
      missingMcp,
      {
        pathExistence: new Map(),
        hookCandidates: new Map([["guard", "/home/target/.local/bin/guard"]]),
        marketplacePayloads: new Map([["local", true]]),
        sharedSkillNames: [],
      },
      paths,
    );
    const nextConfig = Buffer.from(result.codexConfig as Uint8Array).toString();
    expect(nextConfig).toContain('source = "/home/target/.codex/.ccm/marketplaces/local"');
    expect(nextConfig).not.toContain("trusted_hash");
    expect(Buffer.from(result.codexHooks as Uint8Array).toString()).toContain(
      "/home/target/.local/bin/guard",
    );
  });
});
