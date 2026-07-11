import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupLocalDirectoryIfExists, resolveProvidersToRestore } from "../../src/core/restore.ts";

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
});
