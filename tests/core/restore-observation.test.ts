import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";
import { observeLocalRestoreTarget } from "../../src/core/restore-observation.ts";
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
    const bin = join(home, "bin");
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
      incoming: [incoming("codex/config.toml")],
      queries: {
        pathExistence: [join(home, "missing"), bin],
        hookCommands: ["/old/machine/hook"],
        marketplaceNames: ["local", "gone"],
      },
    });

    expect(Buffer.from(observed.claudeMcp.bytes ?? []).toString()).toContain("secret");
    expect(observed.facts.pathExistence.get(bin)).toBe(true);
    expect(observed.facts.hookCandidates.get("hook")).toBe(join(bin, "hook"));
    expect(observed.facts.marketplacePayloads.get("local")).toBe(true);
    expect(observed.facts.sharedSkillNames).toEqual(["empty"]);
    expect(observed.targetFingerprint).not.toContain(home);
    expect(observed.targetFingerprint).not.toContain("secret");
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
});
