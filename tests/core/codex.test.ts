import { describe, expect, it } from "vitest";
import {
  getCodexLocalMarketplaceSources,
  rewriteCodexMarketplaceSources,
} from "../../src/core/codex.ts";

describe("codex helpers", () => {
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
});
