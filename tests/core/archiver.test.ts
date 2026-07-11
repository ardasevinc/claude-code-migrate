import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  async function fixture(rootDir: string, contents = "new\n"): Promise<FileEntry[]> {
    const sourcePath = join(rootDir, `source-${crypto.randomUUID()}`);
    await writeFile(sourcePath, contents, "utf8");
    return [{ sourcePath, relativePath: "codex/AGENTS.md", isSymlink: false }];
  }

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

  it("publishes archives privately and does not clobber existing output by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-publish-test-"));
    const archivePath = join(rootDir, "backup.tar.gz");
    try {
      await writeFile(archivePath, "existing", "utf8");
      await expect(createArchive(await fixture(rootDir), archivePath)).rejects.toThrow(
        `Archive already exists: ${archivePath}`,
      );
      expect(await readFile(archivePath, "utf8")).toBe("existing");

      await createArchive(await fixture(rootDir), archivePath, { force: true });
      expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
      expect((await readdir(rootDir)).some((name) => name.startsWith(".ccm-archive-"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("leaves existing output untouched when archive creation fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-failure-test-"));
    const archivePath = join(rootDir, "backup.tar.gz");
    try {
      await writeFile(archivePath, "existing", "utf8");
      const files: FileEntry[] = [
        { sourcePath: join(rootDir, "missing"), relativePath: "codex/missing", isSymlink: false },
      ];
      await expect(createArchive(files, archivePath, { force: true })).rejects.toThrow();
      expect(await readFile(archivePath, "utf8")).toBe("existing");
      expect((await readdir(rootDir)).some((name) => name.startsWith(".ccm-archive-"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects non-regular archive sources before staging", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-source-test-"));
    try {
      const sourceDir = join(rootDir, "source-dir");
      await mkdir(sourceDir);
      await expect(
        createArchive(
          [{ sourcePath: sourceDir, relativePath: "codex/not-a-file", isSymlink: false }],
          join(rootDir, "backup.tar.gz"),
        ),
      ).rejects.toThrow("Archive source is not a regular file");
      expect((await readdir(rootDir)).some((name) => name.startsWith(".ccm-archive-"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent no-clobber publisher", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-concurrency-test-"));
    const archivePath = join(rootDir, "backup.tar.gz");
    try {
      const results = await Promise.allSettled([
        createArchive(await fixture(rootDir, "first\n"), archivePath),
        createArchive(await fixture(rootDir, "second\n"), archivePath),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(validateArchive(archivePath)).resolves.toBeUndefined();
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

  it("rejects a syntactically valid but malformed legacy manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-manifest-test-"));
    try {
      const sourceDir = join(rootDir, "source");
      const archivePath = join(rootDir, "malformed.tar.gz");
      await mkdir(sourceDir);
      await writeFile(join(sourceDir, ".ccm-manifest.json"), "{}", "utf8");
      await runCommand(`tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} .`, {
        quiet: true,
      });

      await expect(extractArchive(archivePath, join(rootDir, "extract"))).rejects.toThrow(
        "Archive manifest is invalid",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
