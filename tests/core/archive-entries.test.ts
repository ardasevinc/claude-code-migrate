import { describe, expect, it } from "vitest";
import {
  validateArchiveFileEntries,
  validateArchiveMemberPaths,
} from "../../src/core/archive-entries.ts";
import type { FileEntry } from "../../src/types/index.ts";

function entry(relativePath: string): FileEntry {
  return { sourcePath: "/tmp/source", relativePath, isSymlink: false };
}

describe("validateArchiveFileEntries", () => {
  it("rejects duplicate destinations", () => {
    expect(() =>
      validateArchiveFileEntries([entry("codex/config.toml"), entry("codex/config.toml")]),
    ).toThrow("Duplicate archive destination: codex/config.toml");
  });

  it.each([
    "",
    "/absolute",
    "../escape",
    "codex/../escape",
    "codex//config.toml",
    "codex\\config.toml",
    "C:\\config.toml",
    "codex/config\n.toml",
    "codex/config\u0000.toml",
    ".ccm-manifest.json",
  ])("rejects unsafe destination %j", (path) => {
    expect(() => validateArchiveFileEntries([entry(path)])).toThrow("Unsafe archive destination");
  });

  it.each([
    "codex/auth.json",
    "codex/sessions/thread.json",
    "codex/skills/.system/openai-docs/SKILL.md",
    "codex/config.toml/child",
    "claude/history.jsonl",
    "shared/nope",
  ])("rejects unmanaged destination %s", (path) => {
    expect(() => validateArchiveFileEntries([entry(path)])).toThrow("not managed by ccm");
  });

  it("allows managed archive directories and rejects files at parent-only paths", () => {
    expect(
      validateArchiveMemberPaths([
        "./",
        "./.ccm-manifest.json",
        "./codex/",
        "./codex/.tmp/",
        "./codex/.tmp/plugins/",
        "./codex/.tmp/plugins/plugin/file",
      ]),
    ).toContain("codex/.tmp/plugins/plugin/file");
    expect(() => validateArchiveMemberPaths(["./codex/.tmp"])).toThrow("not managed by ccm");
  });
});
