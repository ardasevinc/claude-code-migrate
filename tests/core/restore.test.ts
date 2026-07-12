import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLECTION_PATHS } from "../../src/config/providers.ts";
import { createArchive } from "../../src/core/archiver.ts";
import {
  backupLocalDirectoryIfExists,
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
});
