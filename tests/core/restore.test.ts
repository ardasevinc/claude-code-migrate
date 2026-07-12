import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLECTION_PATHS } from "../../src/config/providers.ts";
import { createArchive } from "../../src/core/archiver.ts";
import {
  backupLocalDirectoryIfExists,
  mergeLocalClaudeMcp,
  resolveProvidersToRestore,
  restoreArchive,
} from "../../src/core/restore.ts";

describe("restore helpers", () => {
  it("returns all available providers when none is requested", () => {
    expect(resolveProvidersToRestore(["claude", "codex"], undefined)).toEqual(["claude", "codex"]);
  });

  it("backs up only managed entries when a managed set is provided", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-managed-backup-test-"));

    try {
      const targetDir = join(rootDir, ".codex");
      await mkdir(targetDir);
      await writeFile(join(targetDir, "config.toml"), "model = 'test'\n", "utf8");
      await writeFile(join(targetDir, "history.jsonl"), "runtime\n", "utf8");

      const backupDir = await backupLocalDirectoryIfExists(targetDir, ["config.toml"]);

      expect(backupDir).not.toBeNull();
      expect(await readFile(join(backupDir as string, "config.toml"), "utf8")).toContain("test");
      await expect(lstat(join(backupDir as string, "history.jsonl"))).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns only the requested provider when present", () => {
    expect(resolveProvidersToRestore(["claude", "codex"], "codex")).toEqual(["codex"]);
  });

  it("returns empty when requested provider is missing", () => {
    expect(resolveProvidersToRestore(["codex"], "claude")).toEqual([]);
  });

  it("backs up existing local directories before restore", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-backup-test-"));

    try {
      const targetDir = join(rootDir, ".codex");
      await mkdir(targetDir);
      await writeFile(join(targetDir, "config.toml"), 'model = "test"\n', "utf8");

      const backupDir = await backupLocalDirectoryIfExists(targetDir);

      expect(backupDir).toMatch(/\.codex\.backup-\d+$/);
      expect(await readFile(join(backupDir ?? "", "config.toml"), "utf8")).toBe('model = "test"\n');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not create a backup for missing local directories", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-backup-test-"));

    try {
      await expect(backupLocalDirectoryIfExists(join(rootDir, ".codex"))).resolves.toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    "codex",
    "claude",
  ] as const)("restores shared-only %s archives without touching the absent provider tree", async (provider) => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-shared-only-test-"));
    const originalPaths = { ...DEFAULT_COLLECTION_PATHS };

    try {
      const sharedSource = join(rootDir, "SKILL.md");
      const archivePath = join(rootDir, `${provider}.tar.gz`);
      await writeFile(sharedSource, "shared\n", "utf8");
      await createArchive(
        [
          {
            sourcePath: sharedSource,
            relativePath: "shared/agents/skills/example/SKILL.md",
            isSymlink: false,
          },
        ],
        archivePath,
        { providers: [provider] },
      );

      const home = join(rootDir, "home");
      Object.assign(DEFAULT_COLLECTION_PATHS, {
        claudeDir: join(home, ".claude"),
        codexDir: join(home, ".codex"),
        claudeMcpConfigPath: join(home, ".claude.json"),
        sharedAgentsDir: join(home, ".agents"),
        sharedSkillsDir: join(home, ".agents", "skills"),
      });

      await restoreArchive(archivePath, provider);

      expect(await readFile(join(home, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe(
        "shared\n",
      );
      await expect(lstat(join(home, `.${provider}`))).rejects.toThrow();
    } finally {
      Object.assign(DEFAULT_COLLECTION_PATHS, originalPaths);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports a shared-only dry run without claiming provider tree work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-shared-only-dry-run-test-"));
    const originalPaths = { ...DEFAULT_COLLECTION_PATHS };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const sharedSource = join(rootDir, "SKILL.md");
      const archivePath = join(rootDir, "codex.tar.gz");
      await writeFile(sharedSource, "shared\n", "utf8");
      await createArchive(
        [
          {
            sourcePath: sharedSource,
            relativePath: "shared/agents/skills/example/SKILL.md",
            isSymlink: false,
          },
        ],
        archivePath,
        { providers: ["codex"] },
      );
      Object.assign(DEFAULT_COLLECTION_PATHS, {
        codexDir: join(rootDir, "home", ".codex"),
        sharedAgentsDir: join(rootDir, "home", ".agents"),
      });

      await restoreArchive(archivePath, "codex", { dryRun: true });

      const output = consoleSpy.mock.calls.flat().join(" ");
      expect(output).toContain("shared agents assets");
      expect(output).not.toContain("codex ->");
      await expect(lstat(join(rootDir, "home"))).rejects.toThrow();
    } finally {
      consoleSpy.mockRestore();
      Object.assign(DEFAULT_COLLECTION_PATHS, originalPaths);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked local Claude MCP merge target without touching its referent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-mcp-shape-test-"));
    const originalPaths = { ...DEFAULT_COLLECTION_PATHS };
    try {
      const incomingMcp = join(rootDir, "mcp.json");
      const claudeFile = join(rootDir, "CLAUDE.md");
      const archivePath = join(rootDir, "claude.tar.gz");
      await writeFile(incomingMcp, '{"mcpServers":{"new":{}}}');
      await writeFile(claudeFile, "provider");
      await createArchive(
        [
          { sourcePath: incomingMcp, relativePath: "claude/.mcp-config.json", isSymlink: false },
          { sourcePath: claudeFile, relativePath: "claude/CLAUDE.md", isSymlink: false },
        ],
        archivePath,
        { providers: ["claude"] },
      );
      const home = join(rootDir, "home");
      const referent = join(rootDir, "outside.json");
      await mkdir(home, { recursive: true });
      await writeFile(referent, '{"mcpServers":{"keep":{}}}');
      await symlink(referent, join(home, ".claude.json"));
      Object.assign(DEFAULT_COLLECTION_PATHS, {
        claudeDir: join(home, ".claude"),
        claudeMcpConfigPath: join(home, ".claude.json"),
      });

      await expect(restoreArchive(archivePath, "claude")).rejects.toThrow(
        "Claude MCP target must be a regular non-symlink file",
      );
      expect(await readFile(referent, "utf8")).toBe('{"mcpServers":{"keep":{}}}');
    } finally {
      Object.assign(DEFAULT_COLLECTION_PATHS, originalPaths);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("atomically replaces a target swapped to a symlink after its safe read", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-restore-mcp-swap-test-"));
    try {
      const extractRoot = join(rootDir, "extract");
      const targetPath = join(rootDir, ".claude.json");
      const referent = join(rootDir, "outside.json");
      await mkdir(join(extractRoot, "claude"), { recursive: true });
      await writeFile(join(extractRoot, "claude", ".mcp-config.json"), '{"mcpServers":{"new":{}}}');
      await writeFile(targetPath, '{"mcpServers":{"old":{}}}');
      await writeFile(referent, "external");

      await mergeLocalClaudeMcp(extractRoot, {
        targetPath,
        beforeCommit: async () => {
          await rm(targetPath);
          await symlink(referent, targetPath);
        },
      });

      expect(await readFile(referent, "utf8")).toBe("external");
      const targetStat = await lstat(targetPath);
      expect(targetStat.isFile()).toBe(true);
      expect(targetStat.isSymbolicLink()).toBe(false);
      expect(targetStat.mode & 0o777).toBe(0o600);
      expect(await readFile(targetPath, "utf8")).toContain('"new"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
