import { describe, expect, it } from "bun:test";
import { buildClaudeSharedSkillSymlinkCommand, parseRemoteHome } from "./ssh.ts";

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
});
