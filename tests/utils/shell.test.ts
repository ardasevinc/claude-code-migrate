import { describe, expect, it } from "vitest";
import { runCommand, shellQuote } from "../../src/utils/shell.ts";

describe("shell wrapper", () => {
  it("returns stdout for successful commands", async () => {
    const result = await runCommand("printf 'ok'", { quiet: true });
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("throws on nonzero exit by default", async () => {
    await expect(runCommand("false", { quiet: true })).rejects.toThrow("Command failed");
  });

  it("does not throw when nothrow is enabled", async () => {
    const result = await runCommand("false", { quiet: true, nothrow: true });
    expect(result.exitCode).toBe(1);
  });

  it("captures stderr for successful commands", async () => {
    const result = await runCommand("node -e \"console.error('warn')\"", { quiet: true });
    expect(result.stderr).toContain("warn");
    expect(result.exitCode).toBe(0);
  });

  it("runs commands in provided cwd", async () => {
    const result = await runCommand("pwd", { quiet: true, cwd: "/tmp" });
    expect(result.stdout.trim().endsWith("/tmp")).toBe(true);
  });
});

describe("shellQuote", () => {
  it("wraps plain values in single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'");
  });

  it("escapes embedded single quotes safely", () => {
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  });
});
