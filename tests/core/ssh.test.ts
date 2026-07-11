import { spawnSync } from "node:child_process";
import type { FileEntry } from "../../src/types/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildArchiveUploadCommand,
  buildClaudeSharedSkillSymlinkCommand,
  buildRemoteManagedBackupCommand,
  buildRemoteHostCapabilityProbeCommand,
  buildRemoteCommandPathResolutionCommand,
  parseRemoteHome,
  previewPush,
  resolvePushActions,
} from "../../src/core/ssh.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ssh helpers", () => {
  it("uses rsync progress when available and falls back to scp", () => {
    expect(buildArchiveUploadCommand("/tmp/archive.tar.gz", "host:/tmp/archive.tar.gz", true)).toBe(
      "rsync --partial --human-readable --info=progress2 '/tmp/archive.tar.gz' 'host:/tmp/archive.tar.gz'",
    );
    expect(
      buildArchiveUploadCommand("/tmp/archive.tar.gz", "host:/tmp/archive.tar.gz", false),
    ).toBe("scp '/tmp/archive.tar.gz' 'host:/tmp/archive.tar.gz'");
  });

  it("parses remote home when absolute", () => {
    expect(parseRemoteHome("/home/arda\n")).toBe("/home/arda");
  });

  it("throws when remote home is unresolved", () => {
    expect(() => parseRemoteHome("\n")).toThrow("Could not resolve remote $HOME");
    expect(() => parseRemoteHome("~\n")).toThrow("Could not resolve remote $HOME");
  });

  it("throws when remote home is not absolute", () => {
    expect(() => parseRemoteHome("home/arda\n")).toThrow("Unexpected remote $HOME value");
  });

  it("builds symlink command that removes preexisting target before linking", () => {
    const command = buildClaudeSharedSkillSymlinkCommand(
      "/home/arda/.claude/skills",
      "/home/arda/.agents/skills",
    );

    expect(command).toContain('rm -rf "$target"');
    expect(command).toContain("ln -s ");
    expect(command).not.toContain("ln -sfn");
  });

  it("generates valid shell syntax (shellcheck)", () => {
    const command = buildClaudeSharedSkillSymlinkCommand(
      "/home/arda/.claude/skills",
      "/home/arda/.agents/skills",
    );

    const result = spawnSync("shellcheck", ["-s", "sh", "-"], {
      input: command,
    });

    if (result.status !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`shellcheck failed:\n${stderr}`);
    }

    expect(result.status).toBe(0);
  });

  it("generates interrupt-safe managed backup shell syntax", () => {
    const command = buildRemoteManagedBackupCommand(
      "/home/arda/.codex",
      "/home/arda/.codex.backup-1234",
      ["config.toml", "hooks.json", ".ccm"],
    );
    const result = spawnSync("shellcheck", ["-s", "sh", "-"], { input: command });

    if (result.status !== 0) {
      throw new Error(`shellcheck failed:\n${result.stderr.toString()}`);
    }

    expect(command).toContain("trap cleanup_backup HUP INT TERM");
    expect(result.status).toBe(0);
  });

  it("builds command lookup with common remote user bin fallbacks", () => {
    const command = buildRemoteCommandPathResolutionCommand("exa-mcp-server", "/home/arda");

    expect(command).toContain("command -v 'exa-mcp-server'");
    expect(command).toContain("'/home/arda/.bun/bin/exa-mcp-server'");
    expect(command).toContain("'/home/arda/.local/bin/exa-mcp-server'");
    expect(command).toContain("'/home/arda/bin/exa-mcp-server'");
  });

  it("generates valid command lookup shell syntax (shellcheck)", () => {
    const command = buildRemoteCommandPathResolutionCommand("exa-mcp-server", "/home/arda");

    const result = spawnSync("shellcheck", ["-s", "sh", "-"], {
      input: command,
    });

    if (result.status !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`shellcheck failed:\n${stderr}`);
    }

    expect(result.status).toBe(0);
  });

  it("generates valid host capability probe shell syntax (shellcheck)", () => {
    const command = buildRemoteHostCapabilityProbeCommand(["adb", "xcodebuild"]);

    const result = spawnSync("shellcheck", ["-s", "sh", "-"], {
      input: command,
    });

    if (result.status !== 0) {
      const stderr = result.stderr.toString();
      throw new Error(`shellcheck failed:\n${stderr}`);
    }

    expect(command).toContain("; if command -v 'xcodebuild'");
    expect(result.status).toBe(0);
  });

  it("plans multi-provider pushes sequentially with shared symlinks last", () => {
    expect(
      resolvePushActions({
        hasClaude: true,
        hasCodex: true,
        hasShared: true,
      }),
    ).toEqual(["claude", "codex", "shared", "claude-shared-symlinks"]);
  });

  it("only recreates claude shared skill symlinks when claude and shared are present", () => {
    expect(
      resolvePushActions({
        hasClaude: false,
        hasCodex: true,
        hasShared: true,
      }),
    ).toEqual(["codex", "shared"]);

    expect(
      resolvePushActions({
        hasClaude: true,
        hasCodex: false,
        hasShared: false,
      }),
    ).toEqual(["claude"]);
  });

  it("previews push with a compact file summary by default", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.join(" "));
    });

    const files: FileEntry[] = [
      {
        sourcePath: "/tmp/config.toml",
        relativePath: "codex/config.toml",
        isSymlink: false,
      },
      {
        sourcePath: "/tmp/plugin-a",
        relativePath: "codex/.ccm/marketplaces/openai-bundled/plugins/browser/SKILL.md",
        isSymlink: false,
      },
      {
        sourcePath: "/tmp/plugin-b",
        relativePath: "codex/.ccm/marketplaces/openai-bundled/plugins/browser/README.md",
        isSymlink: false,
      },
      {
        sourcePath: "/tmp/lazy",
        relativePath: "shared/agents/lazy-skills/example/SKILL.md",
        isSymlink: false,
      },
    ];

    await previewPush(files, "devbox");

    const rendered = output.join("\n");
    expect(rendered).toContain("Push dry-run for devbox");
    expect(rendered).toContain("Transfer summary:");
    expect(rendered).toContain("codex marketplaces/openai-bundled: 2 files");
    expect(rendered).toContain("Sample paths:");
    expect(rendered).not.toContain("Files to transfer (4):");
  });

  it("previews the full push file list when verbose", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.join(" "));
    });

    await previewPush(
      [
        {
          sourcePath: "/tmp/mcp",
          relativePath: "claude/.mcp-config.json",
          isSymlink: false,
        },
      ],
      "devbox",
      { verbose: true },
    );

    const rendered = output.join("\n");
    expect(rendered).toContain("Files to transfer (1):");
    expect(rendered).toContain("~/.claude.json (MCP)");
  });
});
