import { describe, expect, it } from "vitest";
import { createArchiveManifestV2, parseArchiveManifest } from "../../src/core/archive-manifest.ts";

const file = {
  path: "codex/config.toml",
  type: "file" as const,
  size: 12,
  mode: 0o600,
  sha256: "a".repeat(64),
};
const v2 = {
  formatVersion: 2 as const,
  createdAt: "2026-07-12T10:00:00.000Z",
  producer: { name: "claude-code-migrate" as const, version: "1.8.2" },
  providers: ["codex" as const],
  files: [file],
};
const legacy = {
  version: "1.8.2",
  timestamp: "2026-07-12T10:00:00.000Z",
  sourceHost: "host",
  claudeVersion: null,
  providers: ["codex"],
  files: [{ sourcePath: "/tmp/config", relativePath: "codex/config.toml", isSymlink: false }],
};

describe("archive manifest", () => {
  it("parses strict legacy v1 manifests without a discriminator", () => {
    expect(parseArchiveManifest(legacy)).toEqual(legacy);
  });

  it.each([1, "2", null, 2.1, 3])("does not downgrade formatVersion %j", (formatVersion) => {
    expect(() => parseArchiveManifest({ ...legacy, formatVersion })).toThrow("Unsupported");
  });

  it("creates and parses the exact v2 schema", () => {
    expect(createArchiveManifestV2(v2)).toEqual(v2);
  });

  it.each([
    { ...v2, extra: true },
    { ...v2, producer: { ...v2.producer, host: "secret" } },
    { ...v2, files: [{ ...file, sourcePath: "/secret" }] },
  ])("rejects unknown or sensitive fields", (manifest) => {
    expect(() => parseArchiveManifest(manifest)).toThrow("unknown key");
  });

  it.each([
    { ...file, size: -1 },
    { ...file, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...file, mode: 0o1000 },
    { ...file, mode: 1.5 },
    { ...file, sha256: "A".repeat(64) },
    { ...file, type: "symlink" },
  ])("rejects invalid file metadata", (invalidFile) => {
    expect(() => parseArchiveManifest({ ...v2, files: [invalidFile] })).toThrow(
      "manifest file entry is invalid",
    );
  });

  it("rejects duplicate providers and undeclared direct provider roots", () => {
    expect(() => parseArchiveManifest({ ...v2, providers: ["codex", "codex"] })).toThrow();
    expect(() => parseArchiveManifest({ ...v2, providers: ["claude"], files: [file] })).toThrow(
      "not declared",
    );
  });

  it("allows a declared provider for shared-only archives", () => {
    expect(
      parseArchiveManifest({
        ...v2,
        providers: ["claude"],
        files: [{ ...file, path: "shared/agents/.skill-lock.json" }],
      }),
    ).toBeTruthy();
  });

  it("rejects non-canonical, duplicate, and unmanaged paths", () => {
    expect(() =>
      parseArchiveManifest({ ...v2, files: [{ ...file, path: "codex/../auth.json" }] }),
    ).toThrow();
    expect(() => parseArchiveManifest({ ...v2, files: [file, file] })).toThrow("Duplicate");
    expect(() =>
      parseArchiveManifest({ ...v2, files: [{ ...file, path: "codex/auth.json" }] }),
    ).toThrow("not managed");
  });

  it("requires valid dates, providers, and the exact producer", () => {
    expect(() => parseArchiveManifest({ ...v2, createdAt: "nope" })).toThrow("valid date");
    expect(() => parseArchiveManifest({ ...v2, providers: ["other"] })).toThrow();
    expect(() =>
      parseArchiveManifest({ ...v2, producer: { name: "ccm", version: "1" } }),
    ).toThrow();
  });
});
