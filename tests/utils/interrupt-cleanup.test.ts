import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("interrupt cleanup", () => {
  it("removes registered resources and exits 130 on SIGINT", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-interrupt-test-"));
    const owned = join(root, "owned-temp");

    try {
      const child = spawn("bun", ["tests/fixtures/interrupt-cleanup.ts", owned], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGINT");

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });

      expect(exitCode).toBe(130);
      await expect(access(owned)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
