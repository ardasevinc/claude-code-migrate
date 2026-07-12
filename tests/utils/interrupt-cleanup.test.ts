import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupInterruptResources,
  registerInterruptCleanup,
} from "../../src/utils/interrupt-cleanup.ts";

describe("interrupt cleanup", () => {
  it("runs cleanups sequentially in reverse registration order and continues after failure", async () => {
    const events: string[] = [];
    registerInterruptCleanup(async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
    });
    registerInterruptCleanup(async () => {
      events.push("second:start");
      await Promise.resolve();
      events.push("second:end");
      throw new Error("cleanup fault");
    });
    await cleanupInterruptResources();
    expect(events).toEqual(["second:start", "second:end", "first:start", "first:end"]);
  });

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
