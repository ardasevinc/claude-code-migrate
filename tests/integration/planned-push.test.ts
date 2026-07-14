import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  armFault,
  type CommandLogEntry,
  createFakeMachine,
  readCommandLog,
  runCcm,
} from "./harness/index.ts";

function controlPaths(commands: readonly CommandLogEntry[]): string[] {
  return [
    ...new Set(
      commands.flatMap(({ command, args }) =>
        command === "ssh" || command === "scp" || command === "rsync"
          ? args.flatMap((argument) => /-oControlPath=([^\s]+)/.exec(argument)?.[1] ?? [])
          : [],
      ),
    ),
  ];
}

function expectOneClosedSession(commands: readonly CommandLogEntry[]): void {
  const [controlPath] = controlPaths(commands);
  expect(controlPath).toBeDefined();
  for (const { command, args } of commands) {
    if (command !== "ssh" && command !== "scp" && command !== "rsync") continue;
    expect(
      args.some((argument) => argument.includes(`-oControlPath=${controlPath as string}`)),
    ).toBe(true);
  }
  expect(
    commands.filter(
      ({ command, args }) => command === "ssh" && args.includes("-O") && args.includes("exit"),
    ),
  ).toHaveLength(1);
}

async function expectSessionResidueRemoved(commands: readonly CommandLogEntry[]): Promise<void> {
  const [controlPath] = controlPaths(commands);
  expect(controlPath).toBeDefined();
  expect(await lstat(dirname(controlPath as string)).catch(() => null)).toBeNull();
}

describe("planned remote push", () => {
  it("selects a unique host-bound profile and exposes only symbolic provenance", async () => {
    const machine = await createFakeMachine("ccm-planned-push-profile-");
    try {
      const canonicalHome = await realpath(machine.home);
      const configDir = join(canonicalHome, ".config/claude-code-migrate");
      await Promise.all([
        mkdir(join(configDir, "profiles/devbox"), { recursive: true }),
        mkdir(join(canonicalHome, ".codex"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(canonicalHome, ".codex/config.toml"), 'model = "source"\n'),
        writeFile(join(configDir, "profiles/devbox/AGENTS.md"), "devbox instructions\n"),
        writeFile(
          join(configDir, "config.toml"),
          `[providers.codex]\n enabled = true\n\n[profiles.devbox]\nhost = "operator@example.test"\nagents_md = "profiles/devbox/AGENTS.md"\n\n[profiles.devbox.codex.config]\nunset = ["/model"]\n\n[profiles.devbox.codex.config.set]\nmodel_reasoning_effort = "high"\nnotify = ["target-notifier"]\n`,
        ),
      ]);

      const dryRun = await runCcm(
        ["push", "codex", "operator@example.test", "--dry-run", "--json"],
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

      const unprofiled = await runCcm(
        ["push", "codex", "operator@example.test", "--no-auto-profile", "--dry-run", "--json"],
        machine,
        { env: { HOME: canonicalHome } },
      );
      expect(unprofiled.exitCode, unprofiled.stderr).toBe(0);
      const unprofiledPlan = JSON.parse(unprofiled.stdout) as {
        profile?: string;
        actions: Array<{ policyProvenance: string[] }>;
      };
      expect(unprofiledPlan.profile).toBeUndefined();
      expect(unprofiledPlan.actions.flatMap((action) => action.policyProvenance)).not.toContain(
        "profile.devbox.codex-config",
      );

      const live = await runCcm(["push", "codex", "--profile", "devbox"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(live.exitCode, live.stderr).toBe(0);
      const receiptId = /Receipt: (rcpt_[a-f0-9]{32})/.exec(live.stdout)?.[1];
      expect(receiptId).toBeDefined();
      const inspected = await runCcm(["inspect", receiptId as string, "--json"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const receipt = JSON.parse(inspected.stdout) as {
        receipt: { profile?: string; actions: Array<{ policyProvenance?: string[] }> };
      };
      expect(receipt.receipt.profile).toBe("devbox");
      expect(receipt.receipt.actions.flatMap((action) => action.policyProvenance ?? [])).toEqual(
        expect.arrayContaining([
          "profile.devbox.codex-instructions",
          "profile.devbox.codex-config",
        ]),
      );
      expect(inspected.stdout).not.toContain("profiles/devbox/AGENTS.md");
      expect(inspected.stdout).not.toContain("model_reasoning_effort");
      const verified = await runCcm(["verify", receiptId as string, "--json"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(verified.exitCode, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({ valid: true, status: "verified" });
      const latest = await runCcm(["inspect", "latest", "--json"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(JSON.parse(latest.stdout)).toMatchObject({ receipt: { id: receiptId } });
      const receipts = await runCcm(["receipts", "--json"], machine, {
        env: { HOME: canonicalHome },
      });
      expect(JSON.parse(receipts.stdout)).toMatchObject({
        receipts: [{ id: receiptId, profile: "devbox", outcome: "succeeded" }],
      });
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
      await writeFile(
        join(configDir, "config.toml"),
        '[profiles.devbox]\nhost = "operator@example.test"\n[profiles.worker]\nhost = "operator@example.test"\n',
      );
      const ambiguous = await runCcm(
        ["push", "codex", "operator@example.test", "--dry-run"],
        machine,
      );
      expect(ambiguous.exitCode).toBe(2);
      expect(ambiguous.stderr).toContain("Multiple profiles match target");
      expect(await readCommandLog(machine)).toEqual([]);

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
      expectOneClosedSession(commands);
      await expectSessionResidueRemoved(commands);
      expect(commands.some(({ command }) => command === "scp" || command === "rsync")).toBe(true);
      expect(
        commands.some(
          ({ command, args }) =>
            (command === "scp" || command === "rsync") &&
            args.some((argument) => argument.includes("archive.tar.gz")),
        ),
      ).toBe(false);
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
        result.stdout.indexOf("Observing managed state"),
      );
      expect(result.stdout.indexOf("Observing managed state")).toBeLessThan(
        result.stdout.indexOf("Managed state observed"),
      );
      expect(result.stdout.indexOf("Managed state observed")).toBeLessThan(
        result.stdout.indexOf("Executing push plan"),
      );
      expect(result.stdout.indexOf("Executing push plan")).toBeLessThan(
        result.stdout.indexOf("Successfully pushed config"),
      );
      expect(result.stdout).toContain("Successfully pushed config to operator@example.test");
      expect(result.stdout).toMatch(/Receipt: rcpt_[a-f0-9]{32}/);

      const transferCount = commands.filter(
        ({ command }) => command === "scp" || command === "rsync",
      ).length;
      const repeated = await runCcm(["push", "codex", "operator@example.test"], machine);
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      const repeatedCommands = await readCommandLog(machine);
      expect(
        repeatedCommands.filter(({ command }) => command === "scp" || command === "rsync"),
      ).toHaveLength(transferCount);
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
      expect(commands.filter(({ command }) => command === "ssh")).toHaveLength(2);
      expectOneClosedSession(commands);
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
      expectOneClosedSession(commands);
    } finally {
      await machine.dispose();
    }
  });

  it("closes the multiplexed session after a connection failure", async () => {
    const machine = await createFakeMachine("ccm-planned-push-connectivity-");
    try {
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n');
      await armFault(machine, "ssh", { exitCode: 255, stderr: "connection refused\n" });

      const result = await runCcm(["push", "codex", "operator@example.test"], machine);

      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("Cannot connect to operator@example.test");
      const commands = await readCommandLog(machine);
      expectOneClosedSession(commands);
      await expectSessionResidueRemoved(commands);
    } finally {
      await machine.dispose();
    }
  });

  it("retries failed master shutdown and retains the control socket for recovery", async () => {
    const machine = await createFakeMachine("ccm-planned-push-close-failure-");
    let retainedRoot: string | undefined;
    try {
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n');
      await armFault(
        machine,
        "ssh:exit",
        { exitCode: 255, stderr: "control command failed\n" },
        { once: false },
      );

      const result = await runCcm(["push", "codex", "operator@example.test"], machine);

      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain("Could not close multiplexed SSH session");
      const commands = await readCommandLog(machine);
      const [controlPath] = controlPaths(commands);
      expect(controlPath).toBeDefined();
      expect(
        commands.filter(
          ({ command, args }) => command === "ssh" && args.includes("-O") && args.includes("exit"),
        ),
      ).toHaveLength(2);
      retainedRoot = dirname(controlPath as string);
      expect(await lstat(controlPath as string)).toBeTruthy();
    } finally {
      if (retainedRoot) await rm(retainedRoot, { recursive: true, force: true });
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
