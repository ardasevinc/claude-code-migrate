import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  createArchive,
  extractArchive,
  validateArchive,
  validateArchiveEntryPaths,
} from "../../src/core/archiver.ts";
import { runCommand, shellQuote } from "../../src/utils/shell.ts";
import type { FileEntry } from "../../src/types/index.ts";

describe("archiver", () => {
  it("creates a multi-provider archive with shared files once", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-test-"));

    try {
      const sourceDir = join(rootDir, "source");
      const extractDir = join(rootDir, "extract");
      await mkdir(sourceDir);

      const claudeSource = join(sourceDir, "CLAUDE.md");
      const codexSource = join(sourceDir, "AGENTS.md");
      const sharedSource = join(sourceDir, "SKILL.md");

      await writeFile(claudeSource, "claude\n", "utf8");
      await writeFile(codexSource, "codex\n", "utf8");
      await writeFile(sharedSource, "shared\n", "utf8");

      const files: FileEntry[] = [
        {
          sourcePath: claudeSource,
          relativePath: "claude/CLAUDE.md",
          isSymlink: false,
        },
        {
          sourcePath: codexSource,
          relativePath: "codex/AGENTS.md",
          isSymlink: false,
        },
        {
          sourcePath: sharedSource,
          relativePath: "shared/agents/skills/shared-skill/SKILL.md",
          isSymlink: false,
        },
      ];

      const archivePath = join(rootDir, "ccm-test.tar.gz");
      await createArchive(files, archivePath);
      const manifest = await extractArchive(archivePath, extractDir);

      expect(manifest?.version).toBe(packageMetadata.version);
      expect(manifest?.providers).toEqual(["claude", "codex"]);
      expect(await readFile(join(extractDir, "claude", "CLAUDE.md"), "utf8")).toBe("claude\n");
      expect(await readFile(join(extractDir, "codex", "AGENTS.md"), "utf8")).toBe("codex\n");
      expect(
        await readFile(
          join(extractDir, "shared", "agents", "skills", "shared-skill", "SKILL.md"),
          "utf8",
        ),
      ).toBe("shared\n");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects archives containing links", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-link-test-"));

    try {
      const sourceDir = join(rootDir, "source");
      await mkdir(sourceDir);
      await writeFile(join(sourceDir, "target"), "safe\n", "utf8");
      await symlink("target", join(sourceDir, "link"));

      const archivePath = join(rootDir, "unsafe.tar.gz");
      await runCommand(
        `tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} target link`,
        { quiet: true },
      );

      await expect(validateArchive(archivePath)).rejects.toThrow("Unsafe archive entry type: l");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects archive paths that escape the extraction root", () => {
    expect(() => validateArchiveEntryPaths(["./", "../escape"])).toThrow(
      "Unsafe archive path: ../escape",
    );
    expect(() => validateArchiveEntryPaths(["/absolute"])).toThrow(
      "Unsafe archive path: /absolute",
    );
  });
});
