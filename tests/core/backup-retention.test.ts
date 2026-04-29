import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRemoteBackupPruneCommand,
  pruneLocalBackups,
} from "../../src/core/backup-retention.ts";

describe("backup retention", () => {
  it("keeps the newest backups for a target directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-backup-retention-test-"));

    try {
      const targetDir = join(rootDir, ".codex");
      await mkdir(targetDir);

      for (const timestamp of ["1000", "1001", "1002", "1003", "1004", "1005", "1006"]) {
        await mkdir(`${targetDir}.backup-${timestamp}`);
      }

      await mkdir(join(rootDir, ".claude.backup-1000"));
      await mkdir(join(rootDir, ".codex.backup-not-a-timestamp"));

      await pruneLocalBackups(targetDir, 5);

      const entries = await readdir(rootDir);
      expect(entries.sort()).toEqual([
        ".claude.backup-1000",
        ".codex",
        ".codex.backup-1002",
        ".codex.backup-1003",
        ".codex.backup-1004",
        ".codex.backup-1005",
        ".codex.backup-1006",
        ".codex.backup-not-a-timestamp",
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("generates valid shell syntax for remote backup pruning", () => {
    const command = buildRemoteBackupPruneCommand("/home/arda/.codex");

    const result = spawnSync("shellcheck", ["-s", "sh", "-"], {
      input: command,
    });

    if (result.status !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`shellcheck failed:\n${stderr}`);
    }

    expect(result.status).toBe(0);
  });
});
