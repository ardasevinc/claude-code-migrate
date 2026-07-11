import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("terminates an active child before exiting on %s", async (signal, expectedCode) => {
    const root = await mkdtemp(join(tmpdir(), "ccm-process-interrupt-"));
    const marker = join(root, "child-survived");

    try {
      const parent = spawn("bun", ["tests/fixtures/process-interrupt.ts", marker], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        parent.stdout.once("data", () => resolve());
        parent.once("error", reject);
      });

      parent.kill(signal);
      const exitCode = await new Promise<number | null>((resolve) => {
        parent.once("exit", (code) => resolve(code));
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      expect(exitCode).toBe(expectedCode);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
