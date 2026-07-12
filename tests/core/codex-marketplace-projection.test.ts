import { describe, expect, it } from "vitest";
import { projectCodexMarketplaceAvailability } from "../../src/core/codex-marketplace-projection.ts";

const manifest = (path: string, name: string, plugins: string[]) => ({
  path,
  content: JSON.stringify({
    name,
    plugins: plugins.map((pluginName) => ({ name: pluginName, source: `./plugins/${pluginName}` })),
  }),
});

describe("Codex marketplace availability projection", () => {
  it("replaces stale IDs per incoming marketplace and sorts the result", () => {
    expect(
      projectCodexMarketplaceAvailability(
        ["stale@openai-curated", "keep@other", "old@openai-api-curated"],
        [
          manifest("marketplace.json", "openai-curated", ["linear", "atlassian"]),
          manifest("api_marketplace.json", "openai-api-curated", ["game-studio"]),
        ],
      ),
    ).toEqual({
      ok: true,
      availablePluginIds: [
        "atlassian@openai-curated",
        "game-studio@openai-api-curated",
        "keep@other",
        "linear@openai-curated",
      ],
      incomingMarketplaceNames: ["openai-api-curated", "openai-curated"],
    });
  });

  it("accepts repeated declarations only when their plugin sets agree", () => {
    expect(
      projectCodexMarketplaceAvailability(
        [],
        [
          manifest("marketplace.json", "local", ["a", "b"]),
          manifest("api_marketplace.json", "local", ["b", "a"]),
        ],
      ),
    ).toMatchObject({ ok: true, availablePluginIds: ["a@local", "b@local"] });

    expect(
      projectCodexMarketplaceAvailability(
        [],
        [
          manifest("marketplace.json", "local", ["a"]),
          manifest("api_marketplace.json", "local", ["b"]),
        ],
      ),
    ).toEqual({ ok: false, error: "inconsistent marketplace local across incoming manifests" });
  });

  it("fails closed for malformed manifests, unsafe names, and duplicates", () => {
    const invalid = [
      { path: "marketplace.json", content: "{" },
      { path: "marketplace.json", content: JSON.stringify({ name: "bad/name", plugins: [] }) },
      manifest("marketplace.json", "safe", ["../escape"]),
      manifest("marketplace.json", "safe", ["same", "same"]),
    ];

    for (const input of invalid) {
      expect(projectCodexMarketplaceAvailability(["keep@other"], [input])).toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects invalid or duplicate observed IDs atomically", () => {
    expect(projectCodexMarketplaceAvailability(["bad id"], [])).toMatchObject({ ok: false });
    expect(projectCodexMarketplaceAvailability(["a@m", "a@m"], [])).toMatchObject({ ok: false });
  });

  it("rejects missing, unsupported, and unsafe plugin sources atomically", () => {
    for (const source of [undefined, { source: "ftp", url: "ftp://example.com/a" }, "../escape"]) {
      const input = {
        path: "marketplace.json",
        content: JSON.stringify({ name: "local", plugins: [{ name: "demo", source }] }),
      };
      expect(projectCodexMarketplaceAvailability(["keep@other"], [input])).toMatchObject({
        ok: false,
      });
    }
  });

  it("excludes NOT_AVAILABLE and non-Codex products while preserving valid sources", () => {
    const input = {
      path: "api_marketplace.json",
      content: JSON.stringify({
        name: "api",
        plugins: [
          { name: "hidden", source: "./plugins/hidden", policy: { installation: "NOT_AVAILABLE" } },
          {
            name: "chat-only",
            source: { source: "url", url: "https://github.com/openai/chat-only" },
            policy: { products: ["CHATGPT"] },
          },
          {
            name: "default",
            source: { source: "npm", package: "@openai/default", version: "1.0.0" },
            policy: { installation: "INSTALLED_BY_DEFAULT", products: ["CODEX"] },
            futureManifestField: { accepted: true },
          },
        ],
      }),
    };

    expect(projectCodexMarketplaceAvailability(["stale@api"], [input])).toMatchObject({
      ok: true,
      availablePluginIds: ["default@api"],
    });
  });
});
