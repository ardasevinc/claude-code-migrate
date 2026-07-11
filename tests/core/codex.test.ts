import { describe, expect, it } from "vitest";
import {
  adaptCodexConfigForHost,
  getConfiguredCodexPluginNames,
  getCodexLocalMarketplaceSources,
  rewriteCodexMarketplaceSources,
} from "../../src/core/codex.ts";

describe("codex helpers", () => {
  it("lists enabled configured plugins for one marketplace", () => {
    expect(
      getConfiguredCodexPluginNames(
        `
[plugins."build-web-apps@openai-curated"]
enabled = true
[plugins."build-ios-apps@openai-curated"]
enabled = false
[plugins."sites@openai-bundled"]
enabled = true
`,
        "openai-curated",
      ),
    ).toEqual(["build-web-apps"]);
  });

  it("discovers local marketplace sources from codex config", () => {
    const sources = getCodexLocalMarketplaceSources(
      `
[marketplaces.openai-bundled]
source_type = "local"
source = "./bundled"

[marketplaces.remote]
source_type = "github"
source = "openai/example"
`,
      "/tmp/codex",
    );

    expect(sources).toEqual([
      {
        name: "openai-bundled",
        rawSource: "./bundled",
        source: "/tmp/codex/bundled",
      },
    ]);
  });

  it("rewrites local marketplace sources", async () => {
    const rewritten = await rewriteCodexMarketplaceSources(
      `
[marketplaces."openai-primary-runtime"]
source_type = "local"
source = "/Users/arda/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"
last_updated = "2026-06-08T09:05:25Z"
`,
      async (source) => `/home/arda/.codex/.ccm/marketplaces/${source.name}`,
    );

    expect(rewritten.warnings).toEqual([]);
    expect(rewritten.changes).toEqual([
      "openai-primary-runtime: /Users/arda/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime -> /home/arda/.codex/.ccm/marketplaces/openai-primary-runtime",
    ]);
    expect(rewritten.content).toContain(
      'source = "/home/arda/.codex/.ccm/marketplaces/openai-primary-runtime"',
    );
  });

  it("removes missing nonportable notify commands and mcp server sections", async () => {
    const adapted = await adaptCodexConfigForHost(
      `
notify = ["/Users/arda/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/helper", "turn-ended"]

[mcp_servers.exa]
command = "/home/arda/.bun/bin/exa-mcp-server"

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
args = []

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/arda/.codex"
NODE_REPL_NODE_PATH = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node"

[projects."/Users/arda/example"]
trust_level = "trusted"
`,
      async (path) => path === "/home/arda/.bun/bin/exa-mcp-server",
    );

    expect(adapted.warnings).toEqual([]);
    expect(adapted.changes).toEqual([
      "notify: removed missing command /Users/arda/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/helper",
      "node_repl: removed missing MCP command /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    ]);
    expect(adapted.content).not.toContain("notify =");
    expect(adapted.content).not.toContain("mcp_servers.node_repl");
    expect(adapted.content).toContain("[mcp_servers.exa]");
    expect(adapted.content).toContain('[projects."/Users/arda/example"]');
  });

  it("keeps nonportable commands when they exist on the target host", async () => {
    const adapted = await adaptCodexConfigForHost(
      `
[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"
`,
      async () => true,
    );

    expect(adapted.changes).toEqual([]);
    expect(adapted.content).toContain("[mcp_servers.node_repl]");
  });
});
