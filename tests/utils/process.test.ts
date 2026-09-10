import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ProcessError,
  runInheritedProcess,
  runProcess,
  runStreamingProcess,
} from "../../src/utils/process.ts";

describe("process runner", () => {
  it("fully drains concurrent chunked stdout and stderr before returning", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        `
      const { once } = require("node:events");
      async function emit(stream, character) {
        for (let i = 0; i < 96; i++) {
          if (!stream.write(character.repeat(65536))) await once(stream, "drain");
        }
        stream.write("EOF");
      }
      Promise.all([emit(process.stdout, "o"), emit(process.stderr, "e")]);
    `,
      ],
      { timeoutMs: 5000 },
    );
    expect(result.stdout).toBe(`${"o".repeat(96 * 65536)}EOF`);
    expect(result.stderr).toBe(`${"e".repeat(96 * 65536)}EOF`);
  });
  it.each([
    ["capture", runProcess],
    ["stream", runStreamingProcess],
    ["quiet", runStreamingProcess],
  ] as const)("closes unused input and drains large output in %s mode", async (mode, run) => {
    const bytes = 3 * 1024 * 1024;
    const write =
      mode !== "capture"
        ? vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        : undefined;
    try {
      const result = await run(
        process.execPath,
        [
          "-e",
          `process.stdin.on('end', () => process.stdout.write('x'.repeat(${bytes}) + 'EOF')); process.stdin.resume();`,
        ],
        {
          maxBuffer: mode === "capture" ? bytes + 3 : 1024,
          timeoutMs: 3000,
          quiet: mode === "quiet",
        },
      );
      expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
      if (mode !== "capture") {
        expect(result.stdout.length).toBeLessThanOrEqual(1024);
        expect(
          write?.mock.calls.reduce((total, [chunk]) => total + Buffer.byteLength(chunk), 0),
        ).toBe(mode === "quiet" ? 0 : bytes + 3);
      } else {
        expect(result.stdout.length).toBe(bytes + 3);
      }
      expect(result.stdout.endsWith("EOF")).toBe(true);
    } finally {
      write?.mockRestore();
    }
  });

  it.each([
    [0, "warning"],
    [23, "transfer failed"],
  ])("preserves quiet transfer diagnostics at exit %i", async (exitCode, diagnostic) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runStreamingProcess(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode=${exitCode}`],
        { quiet: true, nothrow: true },
      );
      expect(write.mock.calls.map(([chunk]) => chunk.toString()).join("")).toBe(diagnostic);
    } finally {
      write.mockRestore();
    }
  });

  it("terminates a process after timeoutMs", async () => {
    const started = Date.now();
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 25 }),
    ).rejects.toThrow("timed out after 25ms");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("rejects a timed-out process even when its SIGTERM handler exits zero", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow("timed out after 50ms");
  });
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

  it("retains a bounded output tail while streaming", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let result: Awaited<ReturnType<typeof runStreamingProcess>> | undefined;
    try {
      result = await runStreamingProcess(
        process.execPath,
        ["-e", "process.stdout.write('12345')"],
        { maxBuffer: 4 },
      );
    } finally {
      write.mockRestore();
    }

    expect(result).toEqual({ stdout: "2345", stderr: "", exitCode: 0, signal: null });
  });

  it("rejects captured output above the configured limit", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "process.stdout.write('12345')"], { maxBuffer: 4 }),
    ).rejects.toThrow("output exceeded 4 byte buffer limit");
  });

  it("reports buffer overflow when nothrow is enabled", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('12345'); setInterval(() => {}, 1000)"],
      { maxBuffer: 4, nothrow: true },
    );

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
