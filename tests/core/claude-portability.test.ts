import { describe, expect, it } from "vitest";
import { adaptClaudeSettingsForHost } from "../../src/core/claude-portability.ts";

function settings(command: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
    ...extra,
  });
}

function hook(content: string): string {
  return JSON.parse(content).hooks.SessionStart[0].hooks[0].command;
}

describe("Claude settings portability", () => {
  it("remaps explicit source home paths while preserving shell quoting and arguments", () => {
    const command =
      `bash '/Users/arda/.claude/hooks/start.sh' --config="/Users/arda/config.json" ` +
      `ROOT=/Users/arda /Users/arda/.local/bin/runner`;
    const result = adaptClaudeSettingsForHost(settings(command), "/Users/arda", "/home/operator");
    expect(hook(result.content)).toBe(command.replaceAll("/Users/arda", "/home/operator"));
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("adapts statusLine commands and leaves other strings and prompt hooks alone", () => {
    const raw = settings("/Users/arda/bin/hook", {
      statusLine: { type: "command", command: 'python "/Users/arda/bin/status.py"' },
      env: { SOURCE: "/Users/arda/keep" },
      description: "/Users/arda/keep",
      unrelated: { command: "/Users/arda/keep" },
    });
    const result = adaptClaudeSettingsForHost(raw, "/Users/arda", "/home/operator");
    const parsed = JSON.parse(result.content);
    expect(parsed.statusLine.command).toBe('python "/home/operator/bin/status.py"');
    expect(parsed.env.SOURCE).toBe("/Users/arda/keep");
    expect(parsed.description).toBe("/Users/arda/keep");
    expect(parsed.unrelated.command).toBe("/Users/arda/keep");
    const prompt = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "prompt", command: raw }] }] },
    });
    expect(adaptClaudeSettingsForHost(prompt, "/Users/arda", "/home/operator").content).toBe(
      prompt,
    );
  });

  it("does not rewrite overlapping usernames or prefixes embedded in another path", () => {
    const command = "/Users/arda-other/bin/tool /opt/Users/arda/bin/tool";
    const raw = settings(command);
    const result = adaptClaudeSettingsForHost(raw, "/Users/arda", "/home/operator");
    expect(result.content).toBe(raw);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    "/home/operator with spaces",
    "/home/operator;touch /tmp/oops",
    "/home/$USER",
    "/home/../operator",
  ])("leaves commands unchanged when target home needs unsupported shell escaping: %s", (targetHome) => {
    const raw = settings("/Users/arda/bin/start");
    const result = adaptClaudeSettingsForHost(raw, "/Users/arda", targetHome);
    expect(result.content).toBe(raw);
    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("unsupported shell escaping");
  });

  it("retains raw bytes for portable or already-target commands", () => {
    const raw = `${JSON.stringify({ statusLine: { type: "command", command: "~/bin/status" } })}\n\n`;
    expect(adaptClaudeSettingsForHost(raw, "/Users/arda", "/home/operator")).toEqual({
      content: raw,
      changes: [],
      warnings: [],
    });
    const target = settings("/home/operator/bin/start");
    expect(adaptClaudeSettingsForHost(target, "/Users/arda", "/home/operator").warnings).toEqual(
      [],
    );
  });

  it("warns about remaining foreign home paths without guessing a source", () => {
    const raw = settings("/home/someone/bin/start /Users/arda/bin/start");
    const result = adaptClaudeSettingsForHost(raw, "/Users/arda", "/home/operator");
    expect(hook(result.content)).toBe("/home/someone/bin/start /home/operator/bin/start");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("foreign home path remains");
  });

  it.each([
    '{"hooks":',
    '{"hooks":{},"hooks":{}}',
    "null",
    "[]",
  ])("rejects invalid or ambiguous settings: %s", (raw) => {
    expect(() => adaptClaudeSettingsForHost(raw, "/Users/arda", "/home/operator")).toThrow();
  });
});
