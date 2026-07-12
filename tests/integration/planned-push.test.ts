import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeMachine, readCommandLog, runCcm } from "./harness/index.ts";

describe("planned remote push", () => {
  it("applies an explicit host-bound profile and exposes only symbolic provenance", async () => {
    const machine = await createFakeMachine("ccm-planned-push-profile-");
    try {
      const canonicalHome = await realpath(machine.home);
      const configDir = join(canonicalHome, ".config/claude-code-migrate");
      await mkdir(join(configDir, "profiles/devbox"), { recursive: true });
      await Promise.all([
        writeFile(join(configDir, "profiles/devbox/AGENTS.md"), "devbox instructions\n"),
        writeFile(
          join(configDir, "config.toml"),
          `[providers.codex]\n enabled = true\n\n[profiles.devbox]\nhost = "operator@example.test"\nagents_md = "profiles/devbox/AGENTS.md"\n\n[profiles.devbox.codex.config]\nunset = ["/model"]\n\n[profiles.devbox.codex.config.set]\nmodel_reasoning_effort = "high"\nnotify = ["target-notifier"]\n`,
        ),
      ]);

      const dryRun = await runCcm(
        ["push", "codex", "--profile", "devbox", "--dry-run", "--json"],
        machine,
        { env: { HOME: canonicalHome } },
      );
      expect(dryRun.exitCode, dryRun.stderr).toBe(0);
      const plan = JSON.parse(dryRun.stdout) as {
        profile?: string;
        actions: Array<{ policyProvenance: string[] }>;
      };
      expect(plan.profile).toBe("devbox");
      expect(plan.actions.flatMap((action) => action.policyProvenance)).toEqual(
        expect.arrayContaining([
          "profile.devbox.codex-instructions",
          "profile.devbox.codex-config",
        ]),
      );
      expect(dryRun.stdout).not.toContain("profiles/devbox/AGENTS.md");
      expect(dryRun.stdout).not.toContain("model_reasoning_effort");

      const live = await runCcm(["push", "codex", "--profile", "devbox"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(live.exitCode, live.stderr).toBe(0);
      expect(await readFile(join(machine.remoteHome, ".codex/AGENTS.md"), "utf8")).toBe(
        "devbox instructions\n",
      );
      const remoteConfig = await readFile(join(machine.remoteHome, ".codex/config.toml"), "utf8");
      expect(remoteConfig).toContain('model_reasoning_effort = "high"');
      expect(remoteConfig).toContain('notify = [ "target-notifier" ]');
    } finally {
      await machine.dispose();
    }
  }, 30_000);

  it("rejects unknown or target-ambiguous profiles before SSH", async () => {
    const machine = await createFakeMachine("ccm-planned-push-profile-invalid-");
    try {
      const configDir = join(machine.home, ".config/claude-code-migrate");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.toml"),
        '[profiles.devbox]\nhost = "operator@example.test"\n',
      );
      for (const args of [
        ["push", "codex", "--profile", "missing"],
        ["push", "codex", "other@example.test", "--profile", "devbox"],
      ]) {
        const result = await runCcm(args, machine);
        expect(result.exitCode).toBe(2);
      }
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await writeFile(join(machine.home, ".codex/config.toml"), "this is [not toml");
      await writeFile(
        join(configDir, "config.toml"),
        '[profiles.devbox]\nhost = "operator@example.test"\n[profiles.devbox.codex.config.set]\nmodel = "target"\n',
      );
      const malformed = await runCcm(["push", "codex", "--profile", "devbox"], machine);
      expect(malformed.exitCode).toBe(3);
      expect(malformed.stderr).toContain("Cannot apply profile devbox");
      expect(await readCommandLog(machine)).toEqual([]);
    } finally {
      await machine.dispose();
    }
  });

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
