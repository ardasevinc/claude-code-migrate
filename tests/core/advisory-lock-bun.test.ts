import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withAdvisoryFileLock } from "../../src/core/advisory-lock.ts";
import { bunExecutable } from "../integration/harness/index.ts";

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for lock holder");
}

async function run(path: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(bunExecutable, [path], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

describe("Bun kernel advisory lock", () => {
  it("fails closed outside Bun instead of silently using process-local locks", async () => {
    if (typeof globalThis.Bun !== "undefined") return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-node-lock-")));
    const previous = process.env.VITEST;
    try {
      delete process.env.VITEST;
      await expect(withAdvisoryFileLock(join(root, "writer.lock"), async () => {})).rejects.toThrow(
        "Kernel advisory locks require Bun",
      );
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes another process and is automatically released after SIGKILL", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-flock-")));
    const lock = join(root, "writer.lock");
    const marker = join(root, "held");
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, "../../src/core/advisory-lock.ts"),
    ).href;
    const holderPath = join(root, "holder.ts");
    const contenderPath = join(root, "contender.ts");
    await Promise.all([
      writeFile(
        holderPath,
        `import { writeFile } from "node:fs/promises"; import { withAdvisoryFileLock } from ${JSON.stringify(moduleUrl)}; await withAdvisoryFileLock(${JSON.stringify(lock)}, async () => { await writeFile(${JSON.stringify(marker)}, "held"); await new Promise(() => {}); });`,
      ),
      writeFile(
        contenderPath,
        `import { withAdvisoryFileLock } from ${JSON.stringify(moduleUrl)}; try { await withAdvisoryFileLock(${JSON.stringify(lock)}, async () => {}); console.log("acquired"); } catch (error) { console.log(error?.constructor?.name === "BlockedError" ? "blocked" : "error"); }`,
      ),
    ]);
    const holder = spawn(bunExecutable, [holderPath], { stdio: "ignore" });
    try {
      await waitForFile(marker);
      expect(await run(contenderPath)).toMatchObject({ code: 0, stdout: "blocked\n", stderr: "" });
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.once("close", resolve));
      expect(await run(contenderPath)).toMatchObject({ code: 0, stdout: "acquired\n", stderr: "" });
    } finally {
      holder.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
