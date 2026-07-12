import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
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
      await createArchive(files, archivePath, { providers: ["claude", "codex"] });
      const manifest = await extractArchive(archivePath, extractDir);

      expect(manifest.format).toBe("v2");
      expect(manifest.integrity).toBe("verified");
      expect(manifest.producerVersion).toBe(packageMetadata.version);
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

  it("writes a minimal sorted v2 manifest from normalized staged bytes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-v2-test-"));
    try {
      const executable = join(rootDir, "executable");
      const config = join(rootDir, "config");
      await writeFile(executable, "#!/bin/sh\n", "utf8");
      await chmod(executable, 0o711);
      await writeFile(config, 'model = "test"\n', "utf8");
      await chmod(config, 0o600);
      const archivePath = join(rootDir, "backup.tar.gz");
      await createArchive(
        [
          {
            sourcePath: executable,
            relativePath: "shared/agents/skills/z-tool/SKILL.md",
            isSymlink: false,
          },
          { sourcePath: config, relativePath: "codex/config.toml", isSymlink: false },
        ],
        archivePath,
        { providers: ["codex"] },
      );

      const result = await runCommand(`tar -xOzf ${shellQuote(archivePath)} ./.ccm-manifest.json`, {
        quiet: true,
      });
      const manifest = JSON.parse(result.stdout);
      expect(Object.keys(manifest).sort()).toEqual([
        "createdAt",
        "files",
        "formatVersion",
        "producer",
        "providers",
      ]);
      expect(JSON.stringify(manifest)).not.toContain(rootDir);
      expect(JSON.stringify(manifest)).not.toContain("sourcePath");
      expect(JSON.stringify(manifest)).not.toContain("sourceHost");
      expect(JSON.stringify(manifest)).not.toContain("originalSymlinkTarget");
      expect(JSON.stringify(manifest)).not.toContain('model = "test"');
      expect(manifest.providers).toEqual(["codex"]);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
        "codex/config.toml",
        "shared/agents/skills/z-tool/SKILL.md",
      ]);
      expect(manifest.files[0]).toEqual({
        path: "codex/config.toml",
        type: "file",
        size: Buffer.byteLength('model = "test"\n'),
        mode: 0o644,
        sha256: createHash("sha256").update('model = "test"\n').digest("hex"),
      });
      expect(manifest.files[1].mode).toBe(0o755);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("publishes archives privately and does not clobber existing output by default", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-publish-test-"));
    const archivePath = join(rootDir, "backup.tar.gz");
    try {
      await writeFile(archivePath, "existing", "utf8");
      await expect(
        createArchive(await fixture(rootDir), archivePath, { providers: ["codex"] }),
      ).rejects.toThrow(`Archive already exists: ${archivePath}`);
      expect(await readFile(archivePath, "utf8")).toBe("existing");

      await createArchive(await fixture(rootDir), archivePath, {
        providers: ["codex"],
        force: true,
      });
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
      await expect(
        createArchive(files, archivePath, { providers: ["codex"], force: true }),
      ).rejects.toThrow();
      expect(await readFile(archivePath, "utf8")).toBe("existing");
      expect((await readdir(rootDir)).some((name) => name.startsWith(".ccm-archive-"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("publishes only after the temporary archive passes self-verification", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-verify-test-"));
    const archivePath = join(rootDir, "backup.tar.gz");
    const binDir = join(rootDir, "bin");
    const originalPath = process.env.PATH;
    try {
      await mkdir(binDir);
      const fakeTar = join(binDir, "tar");
      await writeFile(fakeTar, '#!/bin/sh\nprintf "not an archive" > "$2"\n', "utf8");
      await chmod(fakeTar, 0o755);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;

      await expect(
        createArchive(await fixture(rootDir), archivePath, { providers: ["codex"] }),
      ).rejects.toThrow();
      await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.env.PATH = originalPath;
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
          [{ sourcePath: sourceDir, relativePath: "codex/config.toml", isSymlink: false }],
          join(rootDir, "backup.tar.gz"),
          { providers: ["codex"] },
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
        createArchive(await fixture(rootDir, "first\n"), archivePath, { providers: ["codex"] }),
        createArchive(await fixture(rootDir, "second\n"), archivePath, { providers: ["codex"] }),
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
      await mkdir(join(sourceDir, "codex"));
      await writeFile(join(sourceDir, "codex", "config.toml"), "safe\n", "utf8");
      await symlink("config.toml", join(sourceDir, "codex", "AGENTS.md"));

      const archivePath = join(rootDir, "unsafe.tar.gz");
      await runCommand(
        `COPYFILE_DISABLE=1 tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} codex/config.toml codex/AGENTS.md`,
        { quiet: true },
      );

      await expect(validateArchive(archivePath)).rejects.toThrow("Unsafe archive entry type");
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
      await runCommand(
        `COPYFILE_DISABLE=1 tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} .`,
        {
          quiet: true,
        },
      );

      await expect(extractArchive(archivePath, join(rootDir, "extract"))).rejects.toThrow(
        "Archive manifest is invalid",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects forbidden and undeclared archive members before extraction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-policy-test-"));
    try {
      const sourceDir = join(rootDir, "source");
      const archivePath = join(rootDir, "forbidden.tar.gz");
      await mkdir(join(sourceDir, "codex"), { recursive: true });
      await writeFile(join(sourceDir, "codex", "auth.json"), '{"token":"secret"}', "utf8");
      await writeFile(
        join(sourceDir, ".ccm-manifest.json"),
        JSON.stringify({
          version: "1.8.2",
          timestamp: new Date().toISOString(),
          sourceHost: "fixture",
          claudeVersion: null,
          providers: ["codex"],
          files: [
            {
              sourcePath: "/source/auth.json",
              relativePath: "codex/auth.json",
              isSymlink: false,
            },
          ],
        }),
        "utf8",
      );
      await runCommand(
        `COPYFILE_DISABLE=1 tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} .`,
        {
          quiet: true,
        },
      );

      await expect(validateArchive(archivePath)).rejects.toThrow("not managed by ccm");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects allowed payload files omitted from the manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ccm-archive-membership-test-"));
    try {
      const sourceDir = join(rootDir, "source");
      const archivePath = join(rootDir, "undeclared.tar.gz");
      await mkdir(join(sourceDir, "codex"), { recursive: true });
      await writeFile(join(sourceDir, "codex", "config.toml"), 'model = "test"', "utf8");
      await writeFile(
        join(sourceDir, ".ccm-manifest.json"),
        JSON.stringify({
          version: "1.8.2",
          timestamp: new Date().toISOString(),
          sourceHost: "fixture",
          claudeVersion: null,
          providers: ["codex"],
          files: [],
        }),
        "utf8",
      );
      await runCommand(
        `COPYFILE_DISABLE=1 tar -czf ${shellQuote(archivePath)} -C ${shellQuote(sourceDir)} .`,
        {
          quiet: true,
        },
      );

      await expect(validateArchive(archivePath)).rejects.toThrow(
        "Archive members do not match the manifest",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
