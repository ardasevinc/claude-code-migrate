import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCodexMcpPathWarnings, mergeMcpServers } from "./mcp.ts";

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

    await Bun.write(
      configPath,
      `
[mcp_servers.local]
command = "../scripts/local-server"
args = ["/usr/local/bin/tool"]
`,
    );

    const warnings = await detectCodexMcpPathWarnings(configPath);

    expect(warnings.some((warning) => warning.includes("command"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("arg"))).toBe(true);
  });
});
