import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bunExecutable } from "../integration/harness/index.ts";

describe("Bun atomic no-replace rename", () => {
  it("never overwrites a destination that appeared before the syscall", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-native-rename-")));
    const source = join(root, "source");
    const destination = join(root, "destination");
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, "../../src/core/native-rename.ts"),
    ).href;
    const script = join(root, "rename.ts");
    try {
      await writeFile(source, "transaction");
      await writeFile(destination, "external");
      await writeFile(
        script,
        `import { renameNoReplace } from ${JSON.stringify(moduleUrl)}; try { await renameNoReplace(${JSON.stringify(source)}, ${JSON.stringify(destination)}); console.log("renamed"); } catch (error) { console.log(error?.constructor?.name); }`,
      );
      const child = spawn(bunExecutable, [script], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect({ code, stdout, stderr }).toEqual({
        code: 0,
        stdout: "BlockedError\n",
        stderr: "",
      });
      expect(await readFile(source, "utf8")).toBe("transaction");
      expect(await readFile(destination, "utf8")).toBe("external");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds backup publication to an open directory descriptor", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-native-rename-at-")));
    const source = join(root, "source");
    const backup = join(root, "backup");
    const displaced = join(root, "displaced-backup");
    const attacker = join(root, "attacker");
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, "../../src/core/native-rename.ts"),
    ).href;
    const script = join(root, "rename-at.ts");
    try {
      await Promise.all([
        writeFile(source, "transaction"),
        import("node:fs/promises").then(({ mkdir }) =>
          Promise.all([mkdir(backup), mkdir(attacker)]),
        ),
      ]);
      await writeFile(
        script,
        `import { open, rename, symlink } from "node:fs/promises"; import { renameNoReplaceAt } from ${JSON.stringify(moduleUrl)}; const handle = await open(${JSON.stringify(backup)}, "r"); await rename(${JSON.stringify(backup)}, ${JSON.stringify(displaced)}); await symlink(${JSON.stringify(attacker)}, ${JSON.stringify(backup)}); await renameNoReplaceAt(${JSON.stringify(source)}, { fd: handle.fd, path: ${JSON.stringify(backup)} }, "value"); await handle.sync(); await handle.close();`,
      );
      const child = spawn(bunExecutable, [script], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(await readFile(join(displaced, "value"), "utf8")).toBe("transaction");
      expect(await import("node:fs/promises").then(({ readdir }) => readdir(attacker))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
