import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

async function runCli(args: string[], home: string) {
  try {
    const result = await execFileAsync("bun", ["src/index.ts", ...args], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, FORCE_COLOR: "1" },
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

async function makeArchive(home: string, manifest: object, body = "model = 'gpt-5'\n") {
  const archivePath = join(home, "operator-secret-name.tar.gz");
  const tar = pack();
  const writing = pipeline(tar, createGzip(), createWriteStream(archivePath));
  for (const [name, content] of [
    ["codex/config.toml", body],
    [".ccm-manifest.json", JSON.stringify(manifest)],
  ] as const) {
    tar.entry({ name, type: "file", size: Buffer.byteLength(content), mode: 0o600 }, content);
  }
  tar.finalize();
  await writing;
  return archivePath;
}

function v2(body = "model = 'gpt-5'\n") {
  return {
    formatVersion: 2,
    createdAt: "2026-07-12T00:00:00.000Z",
    producer: { name: "claude-code-migrate", version: "1.8.2" },
    providers: ["codex"],
    files: [
      {
        path: "codex/config.toml",
        type: "file",
        size: Buffer.byteLength(body),
        mode: 0o600,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ],
  };
}

describe("archive operator commands", () => {
  it("inspects v2 archives as one redacted ANSI-free JSON object", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-inspect-"));
    const archivePath = await makeArchive(home, v2());
    const result = await runCli(["inspect", archivePath, "--files", "--json"], home);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain(`${String.fromCharCode(27)}[`);
    expect(result.stdout).not.toContain(archivePath);
    expect(result.stdout).not.toContain("model =");
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: "v2",
      integrity: "verified",
      providers: ["codex"],
      files: [{ path: "codex/config.toml" }],
    });
  });

  it("reports legacy inspection success but legacy verification as valid-negative", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-legacy-"));
    const archivePath = await makeArchive(home, {
      version: "1.8.2",
      timestamp: "2026-07-12T00:00:00.000Z",
      sourceHost: "secret-host",
      claudeVersion: null,
      providers: ["codex"],
      files: [
        {
          sourcePath: "/secret/source/config.toml",
          relativePath: "codex/config.toml",
          isSymlink: false,
        },
      ],
    });

    const inspected = await runCli(["inspect", archivePath, "--json"], home);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout).not.toContain("secret-host");
    expect(inspected.stdout).not.toContain("sourcePath");
    expect(JSON.parse(inspected.stdout)).toMatchObject({ integrity: "unavailable" });

    const verified = await runCli(["verify", archivePath, "--json"], home);
    expect(verified.exitCode).toBe(1);
    expect(verified.stderr).toBe("");
    expect(JSON.parse(verified.stdout)).toMatchObject({
      valid: false,
      format: "v1",
      integrity: "unavailable",
    });
  });

  it.each([
    "inspect",
    "verify",
  ])("rejects invalid archives through %s with exit 3", async (command) => {
    const home = await mkdtemp(join(tmpdir(), "ccm-invalid-"));
    const archivePath = join(home, "private-invalid-name.tar.gz");
    await writeFile(archivePath, "not an archive");

    const result = await runCli([command, archivePath, "--json"], home);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).not.toContain(archivePath);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: false,
      error: "Archive is invalid or unreadable",
    });
  });

  it("rejects future archive schemas with exit 3", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-future-"));
    const archivePath = await makeArchive(home, { ...v2(), formatVersion: 3 });
    const result = await runCli(["verify", archivePath, "--json"], home);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: false,
      error: "Archive is invalid or unreadable",
    });
  });
});
