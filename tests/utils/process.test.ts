import { describe, expect, it } from "vitest";
import { ProcessError, runInheritedProcess, runProcess } from "../../src/utils/process.ts";

describe("process runner", () => {
  it("executes an argv array without shell interpretation", async () => {
    const argument = "$(printf leaked); ' \" ; echo nope";
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      argument,
    ]);

    expect(result).toEqual({ stdout: argument, stderr: "", exitCode: 0, signal: null });
  });

  it("captures stdout and stderr", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("passes cwd and env", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd() + '|' + process.env.CCM_TEST_VALUE)"],
      { cwd: "/tmp", env: { ...process.env, CCM_TEST_VALUE: "present" } },
    );

    expect(result.stdout.endsWith("/tmp|present")).toBe(true);
  });

  it("throws a typed error without including arguments", async () => {
    const secret = "do-not-leak-this-argument";
    const failure = runProcess(process.execPath, ["-e", "process.exit(7)", secret]);

    await expect(failure).rejects.toMatchObject({
      command: process.execPath,
      result: { exitCode: 7, signal: null },
    });
    await expect(failure).rejects.not.toThrow(secret);
  });

  it("returns failures when nothrow is enabled", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(9)"], {
      nothrow: true,
    });

    expect(result.exitCode).toBe(9);
  });

  it("reports terminating signals", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { nothrow: true },
    );

    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("supports inherited stdio", async () => {
    const result = await runInheritedProcess(process.execPath, ["-e", "process.exit(0)"]);

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0, signal: null });
  });

  it("rejects captured output above the configured limit", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "process.stdout.write('12345')"], { maxBuffer: 4 }),
    ).rejects.toThrow("output exceeded 4 byte buffer limit");
  });

  it("reports buffer overflow when nothrow is enabled", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('12345')"], {
      maxBuffer: 4,
      nothrow: true,
    });

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      error: "output exceeded 4 byte buffer limit",
    });
  });

  it("uses ProcessError for spawn failures", async () => {
    await expect(runProcess("ccm-command-that-does-not-exist")).rejects.toBeInstanceOf(
      ProcessError,
    );
  });
});
