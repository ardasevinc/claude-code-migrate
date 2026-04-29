import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildClaudeSharedSkillSymlinkCommand, parseRemoteHome } from "../../src/core/ssh.ts";

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
});
