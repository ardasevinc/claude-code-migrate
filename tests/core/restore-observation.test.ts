import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";
import { observeLocalRestoreTarget } from "../../src/core/restore-observation.ts";
import { MAX_RESTORE_OBSERVATION_FILE_BYTES } from "../../src/core/restore-observation.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import type { InventoryEntry } from "../../src/core/inventory.ts";

const incoming = (path: string): InventoryEntry => ({
  path,
  type: "file",
  mode: 0o644,
  size: 1,
  sha256: "a".repeat(64),
});

describe("observeLocalRestoreTarget", () => {
  it("inventories only affected roots without following symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(join(paths.codexDir, "skills", "demo"), { recursive: true });
    await writeFile(join(paths.codexDir, "skills", "demo", "SKILL.md"), "live");
    await writeFile(join(paths.codexDir, "AGENTS.md"), "unaffected");
    await symlink("demo", join(paths.codexDir, "skills", "link"));

    const observed = await observeLocalRestoreTarget({
      context: createRuntimeContext({ home }),
      paths,
      selectedProviders: ["codex"],
      incoming: [incoming("codex/skills/new/SKILL.md")],
    });

    expect(observed.inventory.map(({ path, type }) => [path, type])).toEqual([
      ["codex/skills/demo/SKILL.md", "file"],
      ["codex/skills/link", "symlink"],
    ]);
    expect(JSON.stringify(observed)).not.toContain("unaffected");
    expect(JSON.stringify(observed.inventory)).not.toContain('demo"');
  });

  it("captures MCP bytes and exact transform facts but keeps them out of fingerprint", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    const bin = join(home, ".local", "bin");
    await mkdir(join(paths.sharedSkillsDir, "empty"), { recursive: true });
    await mkdir(join(paths.codexDir, ".ccm", "marketplaces", "local"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "hook"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(paths.claudeMcpConfigPath, '{"mcpServers":{"secret":{}}}');
    const context = createRuntimeContext({
      home,
      process: { cwd: () => home, env: { PATH: bin } },
    });
    const observed = await observeLocalRestoreTarget({
      context,
      paths,
      selectedProviders: ["claude", "codex"],
      incoming: [
        incoming("claude/.mcp-config.json"),
        incoming("codex/config.toml"),
        incoming("shared/agents/skills/incoming/SKILL.md"),
        incoming("codex/.ccm/marketplaces/projected/plugin.json"),
      ],
      queries: {
        pathExistence: [join(home, "missing"), bin],
        hookCommands: ["/old/machine/hook"],
        marketplaceNames: ["local", "projected", "gone"],
      },
    });

    expect(Buffer.from(observed.claudeMcp.bytes ?? []).toString()).toContain("secret");
    expect(observed.facts.pathExistence.get(bin)).toBe(true);
    expect(observed.facts.hookCandidates.get("hook")).toBe(join(bin, "hook"));
    expect(observed.facts.marketplacePayloads.get("local")).toBe(true);
    expect(observed.facts.marketplacePayloads.get("projected")).toBe(true);
    expect(observed.facts.sharedSkillNames).toEqual(["empty", "incoming"]);
    expect(observed.targetFingerprint).not.toContain(home);
    expect(observed.targetFingerprint).not.toContain("secret");
  });

  it("observes the MCP pseudo-member only through the bounded MCP channel", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(paths.claudeDir, { recursive: true });
    await writeFile(join(paths.claudeDir, ".mcp-config.json"), "wrong-live-root");
    await writeFile(paths.claudeMcpConfigPath, "actual-mcp");

    const withoutMcp = await observeLocalRestoreTarget({
      context: createRuntimeContext({ home }),
      paths,
      selectedProviders: ["claude"],
      incoming: [incoming("claude/CLAUDE.md")],
    });
    expect(withoutMcp.claudeMcp.exists).toBe(false);

    const withMcp = await observeLocalRestoreTarget({
      context: createRuntimeContext({ home }),
      paths,
      selectedProviders: ["claude"],
      incoming: [incoming("claude/.mcp-config.json")],
    });
    expect(withMcp.inventory).toEqual([]);
    expect(Buffer.from(withMcp.claudeMcp.bytes ?? []).toString()).toBe("actual-mcp");
  });

  it("captures Claude skill subtrees replaced by the projected shared view", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(join(paths.sharedSkillsDir, "existing"), { recursive: true });
    await mkdir(join(paths.claudeDir, "skills", "existing"), { recursive: true });
    await mkdir(join(paths.claudeDir, "skills", "incoming"), { recursive: true });
    await writeFile(join(paths.claudeDir, "skills", "existing", "old"), "one");
    await writeFile(join(paths.claudeDir, "skills", "incoming", "old"), "two");
    const observed = await observeLocalRestoreTarget({
      context: createRuntimeContext({ home }),
      paths,
      selectedProviders: ["claude"],
      incoming: [incoming("shared/agents/skills/incoming/SKILL.md")],
    });
    expect(observed.facts.sharedSkillNames).toEqual(["existing", "incoming"]);
    expect(observed.inventory.map((entry) => entry.path)).toEqual([
      "claude/skills/existing/old",
      "claude/skills/incoming/old",
    ]);
  });

  it("rejects a symlinked shared skills root when recreating Claude's view", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(paths.sharedAgentsDir, { recursive: true });
    await mkdir(join(home, "outside"));
    await symlink(join(home, "outside"), paths.sharedSkillsDir);
    await expect(
      observeLocalRestoreTarget({
        context: createRuntimeContext({ home }),
        paths,
        selectedProviders: ["claude"],
        incoming: [incoming("shared/agents/skills/new/SKILL.md")],
      }),
    ).rejects.toThrow("regular directory");
  });

  it("rejects special files in affected roots", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(join(paths.codexDir, "skills"), { recursive: true });
    const fifo = join(paths.codexDir, "skills", "pipe");
    execFileSync("mkfifo", [fifo]);
    await expect(
      observeLocalRestoreTarget({
        context: createRuntimeContext({ home }),
        paths,
        selectedProviders: ["codex"],
        incoming: [incoming("codex/skills/new")],
      }),
    ).rejects.toThrow("Unsupported special file");
  });

  it("rejects managed files above the named per-file observation cap", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-"));
    const paths = collectionPathsForHome(home);
    await mkdir(paths.codexDir, { recursive: true });
    await writeFile(
      join(paths.codexDir, "config.toml"),
      Buffer.alloc(MAX_RESTORE_OBSERVATION_FILE_BYTES + 1),
    );
    await expect(
      observeLocalRestoreTarget({
        context: createRuntimeContext({ home }),
        paths,
        selectedProviders: ["codex"],
        incoming: [incoming("codex/config.toml")],
      }),
    ).rejects.toThrow("file cap exceeded");
  });
});
