import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeMachine, readCommandLog, runCcm } from "./harness/index.ts";

describe("planned remote push", () => {
  it("executes the transfer plan without replacing unmanaged remote state", async () => {
    const machine = await createFakeMachine("ccm-planned-push-");
    try {
      await Promise.all([
        mkdir(join(machine.home, ".codex/rules"), { recursive: true }),
        mkdir(join(machine.remoteHome, ".codex/unmanaged-runtime"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n'),
        writeFile(join(machine.home, ".codex/rules/managed.md"), "managed source\n"),
        writeFile(join(machine.remoteHome, ".codex/auth.json"), "AUTH-CANARY\n"),
        writeFile(
          join(machine.remoteHome, ".codex/unmanaged-runtime/canary"),
          "UNMANAGED-CANARY\n",
        ),
      ]);

      const result = await runCcm(["push", "codex", "operator@example.test"], machine);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(join(machine.remoteHome, ".codex/config.toml"), "utf8")).toBe(
        'model = "gpt-5.6"\n',
      );
      expect(await readFile(join(machine.remoteHome, ".codex/rules/managed.md"), "utf8")).toBe(
        "managed source\n",
      );
      expect(await readFile(join(machine.remoteHome, ".codex/auth.json"), "utf8")).toBe(
        "AUTH-CANARY\n",
      );
      expect(
        await readFile(join(machine.remoteHome, ".codex/unmanaged-runtime/canary"), "utf8"),
      ).toBe("UNMANAGED-CANARY\n");

      const commands = await readCommandLog(machine);
      expect(commands.some(({ command }) => command === "scp" || command === "rsync")).toBe(true);
      expect(
        commands.some(
          ({ command, args }) =>
            command === "ssh" && args.some((argument) => argument.includes("tar -xzf")),
        ),
      ).toBe(false);
      expect(result.stdout.indexOf("Testing connection")).toBeLessThan(
        result.stdout.indexOf("Connection established"),
      );
      expect(result.stdout.indexOf("Connection established")).toBeLessThan(
        result.stdout.indexOf("Executing push plan"),
      );
      expect(result.stdout.indexOf("Executing push plan")).toBeLessThan(
        result.stdout.indexOf("Successfully pushed config"),
      );
      expect(result.stdout).toContain("Successfully pushed config to operator@example.test");
    } finally {
      await machine.dispose();
    }
  }, 30_000);

  it("prints pure plan JSON and keeps dry-run read-only", async () => {
    const machine = await createFakeMachine("ccm-planned-push-json-");
    try {
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await mkdir(join(machine.remoteHome, ".codex"), { recursive: true });
      await writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n');
      await writeFile(join(machine.remoteHome, ".codex/canary"), "REMOTE-CANARY\n");

      const result = await runCcm(
        ["push", "codex", "operator@example.test", "--dry-run", "--json"],
        machine,
      );

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const plan = JSON.parse(result.stdout) as { kind: string; status: string };
      expect(plan).toMatchObject({ kind: "push", status: "ready" });
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(await readFile(join(machine.remoteHome, ".codex/canary"), "utf8")).toBe(
        "REMOTE-CANARY\n",
      );
      const commands = await readCommandLog(machine);
      expect(commands.some(({ command }) => command === "scp" || command === "rsync")).toBe(false);
      expect(commands.filter(({ command }) => command === "ssh")).toHaveLength(1);
    } finally {
      await machine.dispose();
    }
  });

  it("returns blocked exit 3 without uploading", async () => {
    const machine = await createFakeMachine("ccm-planned-push-blocked-");
    try {
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await writeFile(
        join(machine.home, ".codex/config.toml"),
        '[plugins."unavailable@market"]\nenabled = true\n',
      );

      const result = await runCcm(["push", "codex", "operator@example.test"], machine);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Push plan is blocked");
      const commands = await readCommandLog(machine);
      expect(commands.some(({ command }) => command === "scp" || command === "rsync")).toBe(false);
    } finally {
      await machine.dispose();
    }
  });

  it("runs Claude version checks unless explicitly skipped", async () => {
    for (const skip of [false, true]) {
      const machine = await createFakeMachine(`ccm-planned-push-version-${skip}-`);
      try {
        await mkdir(join(machine.home, ".claude"), { recursive: true });
        await writeFile(join(machine.home, ".claude/settings.json"), '{"theme":"dark"}\n');

        const args = ["push", "claude", "operator@example.test"];
        if (skip) args.push("--skip-version-check");
        const result = await runCcm(args, machine);

        expect(result.exitCode, result.stderr).toBe(0);
        const commands = await readCommandLog(machine);
        expect(
          commands.some(
            ({ command, args: commandArgs }) =>
              command === "claude" && commandArgs.includes("--version"),
          ),
        ).toBe(!skip);
        expect(
          commands.some(
            ({ command, args: commandArgs }) =>
              command === "ssh" && commandArgs.some((arg) => arg === "claude --version"),
          ),
        ).toBe(!skip);
      } finally {
        await machine.dispose();
      }
    }
  }, 30_000);
});
