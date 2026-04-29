import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCodexMcpPathWarnings,
  getCodexMcpCommandPathCandidates,
  mergeMcpServers,
  normalizeCodexMcpCommandPaths,
} from "../../src/core/mcp.ts";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "ccm-mcp-test-"));
});

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe("mcp helpers", () => {
  it("merges mcp servers with incoming values winning", () => {
    const existing = JSON.stringify({
      theme: "dark",
      mcpServers: {
        old: { command: "old" },
        shared: { command: "existing" },
      },
    });

    const incoming = JSON.stringify({
      mcpServers: {
        shared: { command: "incoming" },
        newer: { command: "new" },
      },
    });

    const merged = JSON.parse(mergeMcpServers(existing, incoming)) as {
      mcpServers: Record<string, { command: string }>;
      theme: string;
    };

    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.old?.command).toBe("old");
    expect(merged.mcpServers.shared?.command).toBe("incoming");
    expect(merged.mcpServers.newer?.command).toBe("new");
  });

  it("detects codex path-based mcp entries", async () => {
    const configPath = join(rootDir, "config.toml");

    await writeFile(
      configPath,
      `
[mcp_servers.local]
command = "../scripts/local-server"
args = ["/usr/local/bin/tool"]
`,
      "utf8",
    );

    const warnings = await detectCodexMcpPathWarnings(configPath);

    expect(warnings.some((warning) => warning.includes("command"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("arg"))).toBe(true);
  });

  it("finds codex mcp command path candidates without touching url servers", () => {
    const candidates = getCodexMcpCommandPathCandidates(`
[mcp_servers.exa]
command = "/Users/arda/.bun/bin/exa-mcp-server"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`);

    expect(candidates).toEqual([
      {
        name: "exa",
        command: "/Users/arda/.bun/bin/exa-mcp-server",
        binaryName: "exa-mcp-server",
      },
    ]);
  });

  it("normalizes codex mcp command paths when the binary exists remotely", async () => {
    const normalized = await normalizeCodexMcpCommandPaths(
      `
[mcp_servers.exa]
command = "/Users/arda/.bun/bin/exa-mcp-server"
args = ["tools=web_search_exa"]

[mcp_servers.context7]
command = "/Users/arda/.bun/bin/context7-mcp" # keep comment

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`,
      async (binaryName) =>
        ({
          "context7-mcp": "/home/arda/.bun/bin/context7-mcp",
          "exa-mcp-server": "/home/arda/.bun/bin/exa-mcp-server",
        })[binaryName] ?? null,
    );

    expect(normalized.changes).toEqual([
      "exa: /Users/arda/.bun/bin/exa-mcp-server -> /home/arda/.bun/bin/exa-mcp-server",
      "context7: /Users/arda/.bun/bin/context7-mcp -> /home/arda/.bun/bin/context7-mcp",
    ]);
    expect(normalized.warnings).toEqual([]);
    expect(normalized.content).toContain('command = "/home/arda/.bun/bin/exa-mcp-server"');
    expect(normalized.content).toContain(
      'command = "/home/arda/.bun/bin/context7-mcp" # keep comment',
    );
    expect(normalized.content).toContain('url = "https://mcp.linear.app/mcp"');
  });

  it("leaves unresolved codex mcp command paths unchanged with warnings", async () => {
    const rawConfig = `
[mcp_servers.exa]
command = "/Users/arda/.bun/bin/exa-mcp-server"
`;
    const normalized = await normalizeCodexMcpCommandPaths(rawConfig, async () => null);

    expect(normalized.content).toBe(rawConfig);
    expect(normalized.changes).toEqual([]);
    expect(normalized.warnings).toEqual(["exa: exa-mcp-server not found on remote"]);
  });
});
