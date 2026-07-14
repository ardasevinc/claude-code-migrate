import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctorCommandWithContext } from "../../src/commands/doctor.ts";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";
import { ReportedCliError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import { armFault, createFakeMachine, readCommandLog, runCcm } from "./harness/index.ts";

describe("doctor command", () => {
  it("is locally read-only and emits one stable healthy JSON object", async () => {
    const machine = await createFakeMachine("ccm-doctor-local-");
    try {
      const result = await runCcm(["doctor", "--json"], machine);

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const output = JSON.parse(result.stdout) as {
        kind: string;
        healthy: boolean;
        checks: Array<{ id: string }>;
      };
      expect(output).toMatchObject({ kind: "doctor", healthy: true });
      expect(output.checks.map(({ id }) => id)).toEqual(
        [...output.checks.map(({ id }) => id)].sort(),
      );
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(await readCommandLog(machine)).toEqual([]);
    } finally {
      await machine.dispose();
    }
  });

  it("uses one explicit remote session without exposing the target", async () => {
    const machine = await createFakeMachine("ccm-doctor-remote-");
    try {
      const result = await runCcm(
        ["doctor", "--remote", "operator@example.test", "--json"],
        machine,
      );

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const output = JSON.parse(result.stdout) as {
        healthy: boolean;
        remote: { targetRef: string; commands: { python3: boolean; rsync: boolean } };
      };
      expect(output.healthy).toBe(true);
      expect(output.remote).toMatchObject({
        targetRef: expect.stringMatching(/^endpoint_[a-f0-9]{64}$/),
        commands: { python3: true, rsync: true },
      });
      expect(result.stdout).not.toContain("operator@example.test");
      const commands = await readCommandLog(machine);
      const paths = new Set(
        commands
          .filter(({ command }) => command === "ssh")
          .flatMap(({ args }) =>
            args.flatMap((argument) => /-oControlPath=([^\s]+)/.exec(argument)?.[1] ?? []),
          ),
      );
      expect([...paths]).toHaveLength(1);
      expect(commands.filter(({ command }) => command === "ssh")).toHaveLength(3);
    } finally {
      await machine.dispose();
    }
  });

  it("checks the configured target by default and supports an explicit local-only escape hatch", async () => {
    const machine = await createFakeMachine("ccm-doctor-default-remote-");
    const configDir = join(machine.home, ".config", "claude-code-migrate");
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.toml"),
        '[target]\ntype = "ssh"\nhost = "operator@example.test"\n',
      );

      const remote = await runCcm(["doctor", "--json"], machine);
      expect(remote).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(remote.stdout)).toMatchObject({
        healthy: true,
        remote: { targetRef: expect.stringMatching(/^endpoint_[a-f0-9]{64}$/) },
        checks: expect.arrayContaining([
          { id: "remote-connection", status: "ok", reasonCode: "connection-established" },
        ]),
      });
      expect((await readCommandLog(machine)).some(({ command }) => command === "ssh")).toBe(true);

      await writeFile(machine.commandLog, "", "utf8");
      const local = await runCcm(["doctor", "--local", "--json"], machine);
      expect(local).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(local.stdout)).toMatchObject({
        healthy: true,
        checks: expect.arrayContaining([
          { id: "remote-target", status: "warning", reasonCode: "explicitly-skipped" },
        ]),
      });
      expect(await readCommandLog(machine)).toEqual([]);

      const conflicting = await runCcm(
        ["doctor", "--local", "--remote", "operator@example.test", "--json"],
        machine,
      );
      expect(conflicting.exitCode).toBe(2);
    } finally {
      await machine.dispose();
    }
  });

  it("reports valid-negative health without losing JSON purity", async () => {
    const machine = await createFakeMachine("ccm-doctor-negative-");
    const stateRoot = join(machine.xdgStateHome, "ccm");
    try {
      await armFault(machine, "ssh", { exitCode: 255, stderr: "offline\n" });
      const remote = await runCcm(
        ["doctor", "--remote", "operator@example.test", "--json"],
        machine,
      );
      expect(remote).toMatchObject({ exitCode: 1, stderr: "" });
      expect(JSON.parse(remote.stdout)).toMatchObject({
        healthy: false,
        remote: { os: null, arch: null, commands: { python3: null, rsync: null } },
        checks: expect.arrayContaining([
          { id: "remote-connection", status: "failed", reasonCode: "connection-failed" },
        ]),
      });

      const spoofed = await runCcm(
        ["doctor", "--remote", "operator@example.test", "--json"],
        machine,
        { env: { CCM_TEST_REMOTE_PROBE_PREFIX: "OS=spoofed\n" } },
      );
      expect(spoofed.exitCode).toBe(1);
      expect(JSON.parse(spoofed.stdout)).toMatchObject({
        remote: { os: null, arch: null, commands: { python3: null, rsync: null } },
        checks: expect.arrayContaining([
          { id: "remote-probe", status: "failed", reasonCode: "probe-failed" },
          { id: "remote-python3", status: "warning", reasonCode: "not-observed" },
          { id: "remote-rsync", status: "warning", reasonCode: "not-observed" },
        ]),
      });

      await mkdir(stateRoot, { recursive: true });
      await chmod(stateRoot, 0o755);
      const local = await runCcm(["doctor", "--json"], machine);
      expect(local.exitCode).toBe(1);
      expect(JSON.parse(local.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "state-root", status: "failed", reasonCode: "unsafe-state-directory" },
        ]),
      });

      await chmod(stateRoot, 0o000);
      const inaccessible = await runCcm(["doctor", "--json"], machine);
      expect(inaccessible.exitCode).toBe(1);
      expect(JSON.parse(inaccessible.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "state-root", status: "failed", reasonCode: "unsafe-state-directory" },
        ]),
      });
    } finally {
      await chmod(stateRoot, 0o700).catch(() => undefined);
      await machine.dispose();
    }
  });

  it("rejects symlinked state ancestry without initializing it", async () => {
    const machine = await createFakeMachine("ccm-doctor-state-symlink-");
    try {
      const realState = join(machine.root, "real-state");
      const linkedState = join(machine.root, "linked-state");
      await mkdir(realState);
      await symlink(realState, linkedState);
      const result = await runCcm(["doctor", "--json"], machine, {
        env: { XDG_STATE_HOME: linkedState },
      });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "state-root", status: "failed", reasonCode: "unsafe-state-directory" },
        ]),
      });
      expect(await readCommandLog(machine)).toEqual([]);
    } finally {
      await machine.dispose();
    }
  });

  it("reports malformed and unreadable config as pure JSON", async () => {
    const machine = await createFakeMachine("ccm-doctor-config-");
    const configDir = join(machine.home, ".config", "claude-code-migrate");
    const configPath = join(configDir, "config.toml");
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, "[target\nhost =", "utf8");
      const malformed = await runCcm(["doctor", "--json"], machine);
      expect(malformed).toMatchObject({ exitCode: 1, stderr: "" });
      expect(malformed.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(malformed.stdout)).toMatchObject({
        healthy: false,
        checks: expect.arrayContaining([
          { id: "config", status: "failed", reasonCode: "config-invalid" },
        ]),
      });

      await chmod(configPath, 0o000);
      const unreadable = await runCcm(["doctor", "--json"], machine);
      expect(unreadable).toMatchObject({ exitCode: 1, stderr: "" });
      expect(JSON.parse(unreadable.stdout)).toMatchObject({
        healthy: false,
        checks: expect.arrayContaining([
          { id: "config", status: "failed", reasonCode: "config-invalid" },
        ]),
      });
    } finally {
      await chmod(configPath, 0o600).catch(() => undefined);
      await machine.dispose();
    }
  });

  it("redacts an invalid explicit target while preserving JSON output", async () => {
    const machine = await createFakeMachine("ccm-doctor-target-");
    try {
      const secretTarget = "user:secret@example.test";
      const result = await runCcm(["doctor", "--remote", secretTarget, "--json"], machine);

      expect(result).toMatchObject({ exitCode: 1, stderr: "" });
      expect(result.stdout).not.toContain(secretTarget);
      expect(JSON.parse(result.stdout)).toMatchObject({
        healthy: false,
        checks: expect.arrayContaining([
          { id: "remote-target", status: "failed", reasonCode: "invalid-target" },
        ]),
      });
      expect(await readCommandLog(machine)).toEqual([]);
    } finally {
      await machine.dispose();
    }
  });

  it("checks existing state leaves and accepts stricter private owner modes", async () => {
    const machine = await createFakeMachine("ccm-doctor-state-layout-");
    const stateRoot = join(machine.xdgStateHome, "ccm");
    const transactions = join(stateRoot, "transactions");
    try {
      await mkdir(stateRoot, { mode: 0o700 });
      await symlink(machine.tmpDir, transactions);
      const unsafe = await runCcm(["doctor", "--json"], machine);
      expect(unsafe.exitCode).toBe(1);
      expect(JSON.parse(unsafe.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "state-root", status: "failed", reasonCode: "unsafe-state-directory" },
        ]),
      });

      await unlink(transactions);
      await chmod(stateRoot, 0o500);
      const privateRoot = await runCcm(["doctor", "--json"], machine);
      expect(privateRoot.exitCode).toBe(0);
      expect(JSON.parse(privateRoot.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "state-root", status: "ok", reasonCode: "private-state-directory" },
        ]),
      });
    } finally {
      await chmod(stateRoot, 0o700).catch(() => undefined);
      await machine.dispose();
    }
  });

  it("uses effective execute access for local commands", async () => {
    const machine = await createFakeMachine("ccm-doctor-executable-");
    const hostileBin = join(machine.root, "hostile-bin");
    try {
      await mkdir(hostileBin);
      await writeFile(join(hostileBin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o001 });
      const result = await runCcm(["doctor", "--json"], machine, {
        env: { PATH: hostileBin },
      });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checks: expect.arrayContaining([
          { id: "local-ssh", status: "failed", reasonCode: "command-missing" },
        ]),
      });
    } finally {
      await machine.dispose();
    }
  });

  it("represents SSH session setup failure as a remote transport check", async () => {
    const machine = await createFakeMachine("ccm-doctor-session-setup-");
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const context = createRuntimeContext({
        home: machine.home,
        process: { cwd: () => machine.home, env: machine.env },
      });
      await expect(
        doctorCommandWithContext({ remote: "operator@example.test", json: true }, context, {
          createSession: async () => {
            throw new Error("setup path leaked detail");
          },
          loadConfig: async () => DEFAULT_CONFIG,
        }),
      ).rejects.toBeInstanceOf(ReportedCliError);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain("setup path leaked detail");
      expect(JSON.parse(output[0] as string)).toMatchObject({
        healthy: false,
        checks: expect.arrayContaining([
          { id: "remote-transport", status: "failed", reasonCode: "transport-failed" },
        ]),
      });
    } finally {
      log.mockRestore();
      await machine.dispose();
    }
  });

  it("redacts local filesystem probe failures into the JSON report", async () => {
    const machine = await createFakeMachine("ccm-doctor-local-probe-");
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const base = createRuntimeContext({
        home: machine.home,
        process: { cwd: () => machine.home, env: machine.env },
      });
      const secretPath = join(machine.home, "secret-provider-parent");
      const denied = Object.assign(new Error(`EACCES: ${secretPath}`), { code: "EACCES" });
      const probeFailure = Object.assign(new Error(`EPERM: ${secretPath}`), { code: "EPERM" });
      const context = createRuntimeContext({
        home: base.home,
        process: base.process,
        files: {
          ...base.files,
          lstat: async () => {
            throw denied;
          },
          stat: async () => {
            throw probeFailure;
          },
        } as typeof base.files,
      });

      await expect(
        doctorCommandWithContext({ json: true }, context, {
          createSession: async () => {
            throw new Error("unused");
          },
          loadConfig: async () => DEFAULT_CONFIG,
        }),
      ).rejects.toBeInstanceOf(ReportedCliError);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(secretPath);
      expect(JSON.parse(output[0] as string)).toMatchObject({
        healthy: false,
        checks: expect.arrayContaining([
          { id: "provider-claude", status: "failed", reasonCode: "path-unreadable" },
          { id: "local-ssh", status: "failed", reasonCode: "probe-failed" },
        ]),
      });
    } finally {
      log.mockRestore();
      await machine.dispose();
    }
  });
});
