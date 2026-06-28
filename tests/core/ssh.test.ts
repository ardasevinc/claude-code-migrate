import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildClaudeSharedSkillSymlinkCommand,
  buildRemoteHostCapabilityProbeCommand,
  buildRemoteCommandPathResolutionCommand,
  parseRemoteHome,
  resolvePushActions,
} from "../../src/core/ssh.ts";

describe("ssh helpers", () => {
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
});
