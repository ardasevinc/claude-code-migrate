import { describe, expect, it } from "vitest";
import { adaptCodexHooksForHost } from "../../src/core/codex-hooks.ts";

describe("codex hooks", () => {
  it("rewrites hook commands and preserves verified trust under the target key", async () => {
    const hooks = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [
              {
                type: "command",
                command: "/Users/arda/.local/bin/codex-home-guard",
                timeout: 1,
                statusMessage: "Checking catastrophic filesystem scope",
              },
            ],
          },
        ],
      },
    });
    const config = `
[hooks.state."/Users/arda/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:5731907957c50fb9861207e29bc456de92b8496b2eb9f2f8fd5e3d135c46c583"

[marketplaces.example]
source_type = "github"
`;

    const adapted = await adaptCodexHooksForHost(
      hooks,
      config,
      "/home/arda/.codex/hooks.json",
      async () => "/home/arda/.local/bin/codex-home-guard",
    );

    expect(adapted.warnings).toEqual([]);
    expect(adapted.trusted).toBe(1);
    expect(adapted.hooksContent).toContain("/home/arda/.local/bin/codex-home-guard");
    expect(adapted.configContent).not.toContain("/Users/arda/.codex/hooks.json");
    expect(adapted.configContent).toContain(
      '[hooks.state."/home/arda/.codex/hooks.json:pre_tool_use:0:0"]',
    );
    expect(adapted.configContent).toContain("[marketplaces.example]");
  });

  it("does not preserve trust when the target command is unavailable", async () => {
    const hooks = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: "/Users/arda/.local/bin/missing" }],
          },
        ],
      },
    });
    const config = `
[hooks.state."/Users/arda/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:not-current"
`;

    const adapted = await adaptCodexHooksForHost(
      hooks,
      config,
      "/home/arda/.codex/hooks.json",
      async () => null,
    );

    expect(adapted.trusted).toBe(0);
    expect(adapted.warnings).toHaveLength(1);
    expect(adapted.configContent).not.toContain("trusted_hash");
  });
});
