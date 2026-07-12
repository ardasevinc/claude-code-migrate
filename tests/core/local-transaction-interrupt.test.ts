import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bunExecutable } from "../integration/harness/index.ts";

describe("local transaction subprocess interrupts", () => {
  it.each([
    ["journal:committing", "SIGINT", 130],
    ["renamed:rollback:codex-agents", "SIGTERM", 143],
  ] as const)("rolls back %s on %s before exiting", async (boundary, signal, expectedCode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-transaction-interrupt-")));
    try {
      const child = spawn(
        bunExecutable,
        ["tests/fixtures/local-transaction-interrupt.ts", root, boundary],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("close", (code) =>
          reject(
            new Error(
              `fixture exited early: ${code}: ${stderr.map((chunk) => chunk.toString()).join("")}`,
            ),
          ),
        );
      });
      child.kill(signal);
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });

      expect(stderr.map((chunk) => chunk.toString()).join("")).toBe("");
      expect(exitCode).toBe(expectedCode);
      expect(await readFile(join(root, "home/.codex/AGENTS.md"), "utf8")).toBe("old\n");
      expect(
        (await readdir(join(root, "state/ccm/transactions"))).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toEqual([]);
      const homeEntries = await readdir(join(root, "home"));
      expect(homeEntries.filter((name) => name.startsWith(".ccm-transaction-"))).toEqual([]);
      expect(homeEntries.filter((name) => name.startsWith(".codex.backup-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
