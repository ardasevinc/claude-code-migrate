import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { describe, expect, it } from "vitest";
import { verifyArchive } from "../../src/core/archive-reader.ts";

async function archive(
  entries: Array<{ name: string; body?: string; type?: "file" | "directory"; mode?: number }>,
) {
  const root = await mkdtemp(join(tmpdir(), "ccm-reader-test-"));
  const path = join(root, "archive.tar.gz");
  const tar = pack();
  const writing = pipeline(tar, createGzip(), createWriteStream(path));
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    tar.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        size: body.length,
        mode: entry.mode ?? 0o600,
      },
      body,
    );
  }
  tar.finalize();
  await writing;
  return { root, path };
}

function v2(path: string, body: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    formatVersion: 2,
    createdAt: "2026-07-12T00:00:00.000Z",
    producer: { name: "claude-code-migrate", version: "2.0.0" },
    providers: ["codex"],
    files: [
      {
        path,
        type: "file",
        size: Buffer.byteLength(body),
        mode: 0o600,
        sha256: createHash("sha256").update(body).digest("hex"),
        ...overrides,
      },
    ],
  });
}

describe("streaming archive reader", () => {
  it("verifies v2 content with a trailing manifest and extracts privately", async () => {
    const body = "model = 'gpt-5'\n";
    const input = await archive([
      { name: "./codex/config.toml", body },
      { name: "./.ccm-manifest.json", body: v2("codex/config.toml", body) },
    ]);
    const destination = join(input.root, "out");
    const result = await verifyArchive(input.path, { extractTo: destination });
    expect(result).toMatchObject({
      format: "v2",
      integrity: "verified",
      payloadBytes: Buffer.byteLength(body),
      entryCount: 2,
    });
    expect(result.files[0]).toMatchObject({ path: "codex/config.toml", mode: 0o600 });
    expect(await readFile(join(destination, "codex/config.toml"), "utf8")).toBe(body);
    expect((await stat(join(destination, "codex/config.toml"))).mode & 0o777).toBe(0o600);
  });

  it("projects legacy metadata without leaking source paths", async () => {
    const manifest = JSON.stringify({
      version: "1.8.2",
      timestamp: "2026-07-12T00:00:00.000Z",
      sourceHost: "secret-host",
      claudeVersion: null,
      providers: ["codex"],
      files: [{ sourcePath: "/secret/auth", relativePath: "codex/config.toml", isSymlink: false }],
    });
    const input = await archive([
      { name: ".ccm-manifest.json", body: manifest },
      { name: "codex/config.toml", body: "x" },
    ]);
    const result = await verifyArchive(input.path);
    expect(result).toMatchObject({
      format: "v1",
      integrity: "unavailable",
      producerVersion: "1.8.2",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.files[0]?.sha256).toBeUndefined();
  });

  it("verifies without creating a temporary extraction workspace", async () => {
    const body = "model = 'gpt-5'\n";
    const input = await archive([
      { name: "codex/config.toml", body },
      { name: ".ccm-manifest.json", body: v2("codex/config.toml", body) },
    ]);
    const isolatedTmp = join(input.root, "tmp");
    await mkdir(isolatedTmp);
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      const result = await verifyArchive(input.path);

      expect(result.integrity).toBe("verified");
      expect(await readdir(isolatedTmp)).toEqual([]);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  });

  it("rejects mismatched hashes and removes partial extraction", async () => {
    const input = await archive([
      {
        name: ".ccm-manifest.json",
        body: v2("codex/config.toml", "actual", { sha256: "0".repeat(64) }),
      },
      { name: "codex/config.toml", body: "actual" },
    ]);
    const destination = join(input.root, "out");
    await expect(verifyArchive(input.path, { extractTo: destination })).rejects.toThrow(
      "integrity mismatch",
    );
    await expect(stat(destination)).rejects.toThrow();
  });

  it("rejects a preexisting symlink destination without touching its target", async () => {
    const input = await archive([{ name: "codex/config.toml", body: "hostile" }]);
    const target = join(input.root, "caller-owned");
    const destination = join(input.root, "out");
    await mkdir(target);
    await writeFile(join(target, "canary"), "preserve me");
    await symlink(target, destination);

    await expect(verifyArchive(input.path, { extractTo: destination })).rejects.toThrow();
    expect(await readFile(join(target, "canary"), "utf8")).toBe("preserve me");
    await expect(stat(join(target, "codex/config.toml"))).rejects.toThrow();
  });

  it("applies the verified executable mode", async () => {
    const body = "#!/bin/sh\nexit 0\n";
    const input = await archive([
      { name: "codex/hooks.json", body, mode: 0o755 },
      { name: ".ccm-manifest.json", body: v2("codex/hooks.json", body, { mode: 0o755 }) },
    ]);
    const destination = join(input.root, "out");
    await verifyArchive(input.path, { extractTo: destination });
    expect((await stat(join(destination, "codex/hooks.json"))).mode & 0o777).toBe(0o755);
  });

  it("enforces injectable streaming limits", async () => {
    const input = await archive([{ name: "codex/config.toml", body: "too large" }]);
    await expect(verifyArchive(input.path, { limits: { compressedBytes: 1 } })).rejects.toThrow(
      "Compressed archive size limit exceeded",
    );
  });

  it.each([
    ["duplicate", ["codex/config.toml", "codex/config.toml"]],
    ["portable collision", ["codex/skills/demo/SKILL.md", "codex/skills/DEMO/SKILL.md"]],
    ["ancestor case collision", ["codex/skills/Demo/one.md", "codex/skills/demo/two.md"]],
    ["ancestor NFC collision", ["codex/skills/café/one.md", "codex/skills/café/two.md"]],
  ])("rejects %s paths", async (_label, names) => {
    const input = await archive(names.map((name) => ({ name, body: "x" })));
    await expect(verifyArchive(input.path)).rejects.toThrow(/Duplicate|collision/);
  });

  it.each([
    [
      "top-level",
      '{"formatVersion":1,"formatVersion":2,"createdAt":"2026-07-12T00:00:00.000Z","producer":{"name":"claude-code-migrate","version":"2.0.0"},"providers":["codex"],"files":[]}',
    ],
    [
      "nested escaped",
      '{"formatVersion":2,"createdAt":"2026-07-12T00:00:00.000Z","producer":{"name":"claude-code-migrate","na\\u006de":"claude-code-migrate","version":"2.0.0"},"providers":["codex"],"files":[]}',
    ],
  ])("rejects duplicate JSON keys at %s scope", async (_label, manifest) => {
    const input = await archive([{ name: ".ccm-manifest.json", body: manifest }]);
    await expect(verifyArchive(input.path)).rejects.toThrow("Archive manifest is invalid");
  });
});
