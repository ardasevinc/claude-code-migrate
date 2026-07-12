import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { smokePackage } from "../../scripts/smoke-package.ts";
import {
  assertPackedContents,
  assertReleaseVersions,
  changelogSection,
  type CommandRunner,
  readTarEntries,
  verifyRelease,
} from "../../scripts/verify-release.ts";

const temporaryDirectories: string[] = [];

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarball(files: Array<{ name: string; data: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, file.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeOctal(
      header,
      148,
      8,
      [...header].reduce((sum, byte) => sum + byte, 0),
    );
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ccm-release-test-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "claude-code-migrate", version: "1.8.2" }),
  );
  await writeFile(
    join(directory, "CHANGELOG.md"),
    "# Changelog\n\n## [1.8.2] - 2026-07-12\n\n- Verified release.\n",
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release contract", () => {
  test("requires tag, package, and CLI versions to agree", () => {
    expect(() =>
      assertReleaseVersions({ tag: "v1.8.2", packageVersion: "1.8.2", cliVersion: "1.8.2" }),
    ).not.toThrow();
    expect(() =>
      assertReleaseVersions({ tag: "v1.8.3", packageVersion: "1.8.2", cliVersion: "1.8.2" }),
    ).toThrow("does not match package version");
    expect(() =>
      assertReleaseVersions({ tag: "1.8.2", packageVersion: "1.8.2", cliVersion: "1.8.2" }),
    ).toThrow("vX.Y.Z");
  });

  test("requires a dated, non-empty changelog section", () => {
    expect(changelogSection("## [1.8.2] - 2026-07-12\n\n- Fixed it.\n", "1.8.2")).toBe(
      "- Fixed it.",
    );
    expect(() => changelogSection("## [Unreleased]\n", "1.8.2")).toThrow("exactly one dated");
    expect(() =>
      changelogSection(
        "## [1.8.2] - 2026-07-12\n\n- One.\n\n## [1.8.2] - 2026-07-13\n\n- Two.\n",
        "1.8.2",
      ),
    ).toThrow("exactly one dated");
  });

  test("checks the exact packed surface, metadata, and executable", () => {
    const archive = tarball([
      {
        name: "package/package.json",
        data: JSON.stringify({ version: "1.8.2", bin: { ccm: "./src/index.ts" } }),
      },
      { name: "package/src/index.ts", data: "#!/usr/bin/env bun\n", mode: 0o755 },
      { name: "package/src/core/remote-push-helper.py", data: "print('helper')\n" },
    ]);
    const entries = readTarEntries(archive);
    expect(() =>
      assertPackedContents(
        entries,
        ["package/package.json", "package/src/index.ts", "package/src/core/remote-push-helper.py"],
        "1.8.2",
      ),
    ).not.toThrow();
    expect(() => assertPackedContents(entries, ["package/package.json"], "1.8.2")).toThrow(
      "extra: package/src/core/remote-push-helper.py, package/src/index.ts",
    );
  });

  test("verifies tag location, main ancestry, CLI, changelog, and tarball together", async () => {
    const directory = await fixtureDirectory();
    const archivePath = join(directory, "claude-code-migrate-1.8.2.tgz");
    await writeFile(
      archivePath,
      tarball([
        {
          name: "package/package.json",
          data: JSON.stringify({ version: "1.8.2", bin: { ccm: "./src/index.ts" } }),
        },
        { name: "package/README.md", data: "readme" },
        { name: "package/LICENSE", data: "license" },
        { name: "package/CHANGELOG.md", data: "changelog" },
        { name: "package/src/index.ts", data: "#!/usr/bin/env bun\n", mode: 0o755 },
        { name: "package/src/core/remote-push-helper.py", data: "print('helper')\n" },
      ]),
    );
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
      if (args[0] === "ls-files") {
        return { stdout: "src/index.ts\nsrc/core/remote-push-helper.py\n", stderr: "" };
      }
      if (command === "bun") return { stdout: "1.8.2\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    await expect(
      verifyRelease({
        tag: "v1.8.2",
        tarball: archivePath,
        mainRef: "origin/main",
        cwd: directory,
        run,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toContain("git merge-base --is-ancestor v1.8.2 origin/main");
  });

  test("rejects a tag outside main ancestry", async () => {
    const directory = await fixtureDirectory();
    const run: CommandRunner = async (command, args) => {
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
      if (args[0] === "ls-files") {
        return { stdout: "src/index.ts\nsrc/core/remote-push-helper.py\n", stderr: "" };
      }
      if (args[0] === "merge-base") throw new Error("not ancestor");
      if (command === "bun") return { stdout: "1.8.2\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await expect(
      verifyRelease({
        tag: "v1.8.2",
        tarball: join(directory, "claude-code-migrate-1.8.2.tgz"),
        mainRef: "origin/main",
        cwd: directory,
        run,
      }),
    ).rejects.toThrow("not an ancestor");
  });

  test("smokes an exact tarball through isolated npm install commands", async () => {
    const directory = await fixtureDirectory();
    const archivePath = join(directory, "claude-code-migrate-1.8.2.tgz");
    await writeFile(
      archivePath,
      tarball([{ name: "package/package.json", data: JSON.stringify({ version: "1.8.2" }) }]),
    );
    const calls: Array<{ command: string; args: readonly string[]; home?: string }> = [];
    const run: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, home: options?.env?.HOME });
      if (args[0] === "--version") return { stdout: "1.8.2\n", stderr: "" };
      if (args[0] === "--help") return { stdout: "Usage: ccm [options]\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    await smokePackage(archivePath, { run });
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args.at(-1)).toBe(archivePath);
    expect(calls[0]?.home).toContain("ccm-package-smoke-");
    expect(calls[1]?.command).toContain("/prefix/bin/ccm");
  });
});
