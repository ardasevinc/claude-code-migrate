import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executePlannedBackup, planBackup } from "../../src/core/plan-backup.ts";

describe("backup migration planning", () => {
  it("is deterministic and keeps raw resources out of the public plan", async () => {
    const rawSource = "/private/Users/arda/.codex/config.toml";
    const rawTarget = "/private/Users/arda/backups/secret.tar.gz";
    const symlinkTarget = "../../private/skill";
    const input = {
      files: [
        {
          sourcePath: rawSource,
          relativePath: "codex/config.toml",
          isSymlink: true,
          originalSymlinkTarget: symlinkTarget,
          mcpServersOnly: "model = 'test'\n",
        },
      ],
      outputPath: rawTarget,
      providers: ["codex" as const],
      force: false,
      createdAt: "2026-07-12T00:00:00.000Z",
    };

    const first = await planBackup(input);
    const second = await planBackup(input);
    expect(first.plan).toEqual(second.plan);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(rawSource);
    expect(serialized).not.toContain(rawTarget);
    expect(serialized).not.toContain(symlinkTarget);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan)).toBe(true);
  });

  it("blocks source drift before creating the output archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-backup-test-"));
    try {
      const sourcePath = join(root, "config.toml");
      const outputPath = join(root, "backup.tar.gz");
      await writeFile(sourcePath, "model = 'before'\n");
      const planned = await planBackup({
        files: [{ sourcePath, relativePath: "codex/config.toml", isSymlink: false }],
        outputPath,
        providers: ["codex"],
        force: false,
      });

      await writeFile(sourcePath, "model = 'after'\n");
      await expect(executePlannedBackup(planned)).rejects.toThrow(
        "Backup source changed after planning",
      );
      expect(await lstat(outputPath).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the old output when the source races during staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-backup-race-test-"));
    try {
      const sourcePath = join(root, "config.toml");
      const outputPath = join(root, "backup.tar.gz");
      await writeFile(sourcePath, "model = 'planned'\n");
      await writeFile(outputPath, "old archive\n");
      const planned = await planBackup({
        files: [{ sourcePath, relativePath: "codex/config.toml", isSymlink: false }],
        outputPath,
        providers: ["codex"],
        force: true,
        beforePublishTestHook: async () => {
          await writeFile(sourcePath, "model = 'raced'\n");
        },
      });

      await expect(executePlannedBackup(planned)).rejects.toThrow(
        "Backup source changed during archive creation",
      );
      expect(await readFile(outputPath, "utf8")).toBe("old archive\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a target that changes during staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-backup-target-race-test-"));
    try {
      const sourcePath = join(root, "config.toml");
      const outputPath = join(root, "backup.tar.gz");
      await writeFile(sourcePath, "model = 'planned'\n");
      await writeFile(outputPath, "original archive\n");
      const planned = await planBackup({
        files: [{ sourcePath, relativePath: "codex/config.toml", isSymlink: false }],
        outputPath,
        providers: ["codex"],
        force: true,
        beforePublishTestHook: async () => {
          await writeFile(outputPath, "concurrent replacement\n");
        },
      });

      await expect(executePlannedBackup(planned)).rejects.toThrow(
        "Backup target changed during archive creation",
      );
      expect(await readFile(outputPath, "utf8")).toBe("concurrent replacement\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a non-file target even with force", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-backup-target-test-"));
    try {
      const outputPath = join(root, "backup.tar.gz");
      await mkdir(outputPath);
      const planned = await planBackup({
        files: [
          {
            sourcePath: "/unused",
            relativePath: "codex/config.toml",
            isSymlink: false,
            mcpServersOnly: "",
          },
        ],
        outputPath,
        providers: ["codex"],
        force: true,
      });
      expect(planned.plan.status).toBe("blocked");
      expect(planned.plan.preconditions[0]?.reasonCode).toBe("target-not-file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a stable semantic endpoint for default output filenames", async () => {
    const base = {
      files: [
        {
          sourcePath: "/unused",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: "",
        },
      ],
      providers: ["codex" as const],
      force: false,
      outputSource: "default" as const,
    };
    const first = await planBackup({ ...base, outputPath: "/tmp/backup-one.tar.gz" });
    const second = await planBackup({ ...base, outputPath: "/tmp/backup-two.tar.gz" });
    expect(first.plan.id).toBe(second.plan.id);
    expect(first.plan.target.ref).toBe(second.plan.target.ref);
  });

  it("rejects an unsealed lookalike plan", async () => {
    const planned = await planBackup({
      files: [
        {
          sourcePath: "/unused",
          relativePath: "codex/config.toml",
          isSymlink: false,
          mcpServersOnly: "",
        },
      ],
      outputPath: "/tmp/unused.tar.gz",
      providers: ["codex"],
      force: false,
    });
    await expect(executePlannedBackup({ plan: planned.plan })).rejects.toThrow(
      "not a sealed planner result",
    );
  });
});
