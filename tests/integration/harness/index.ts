import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

const SHIM_NAMES = ["ssh", "scp", "rsync", "claude", "codex"] as const;

export const projectRoot = resolve(import.meta.dirname, "../../..");
export const bunExecutable = await resolveBunExecutable();

export interface FakeMachine {
  readonly root: string;
  readonly home: string;
  readonly remoteHome: string;
  readonly tmpDir: string;
  readonly remoteTmpDir: string;
  readonly xdgConfigHome: string;
  readonly xdgCacheHome: string;
  readonly xdgDataHome: string;
  readonly shimDir: string;
  readonly commandLog: string;
  readonly faultDir: string;
  readonly env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export interface SubprocessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

export interface CommandLogEntry {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly home: string | null;
}

export interface FaultSpec {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export async function createFakeMachine(prefix = "ccm-fake-machine-"): Promise<FakeMachine> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const remoteHome = join(root, "remote-home");
  const tmp = join(root, "tmp");
  const remoteTmp = join(root, "remote-tmp");
  const xdgConfig = join(root, "xdg", "config");
  const xdgCache = join(root, "xdg", "cache");
  const xdgData = join(root, "xdg", "data");
  const shimDir = join(root, "bin");
  const faultDir = join(root, "faults");
  const commandLog = join(root, "commands.ndjson");
  await Promise.all(
    [home, remoteHome, tmp, remoteTmp, xdgConfig, xdgCache, xdgData, shimDir, faultDir].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(commandLog, "", "utf8");

  const dispatcher = join(import.meta.dirname, "shim-dispatcher.ts");
  const shim = `#!/bin/sh\nexec "$CCM_TEST_BUN" "$CCM_TEST_SHIM_DISPATCHER" "\${0##*/}" "$@"\n`;
  for (const name of SHIM_NAMES) {
    const path = join(shimDir, name);
    await writeFile(path, shim, "utf8");
    await chmod(path, 0o755);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    CCM_TEST_BUN: bunExecutable,
    CCM_TEST_SHIM_DISPATCHER: dispatcher,
    CCM_TEST_COMMAND_LOG: commandLog,
    CCM_TEST_FAULT_DIR: faultDir,
    CCM_TEST_REMOTE_HOME: remoteHome,
    CCM_TEST_REMOTE_TMPDIR: remoteTmp,
  };
  delete env.FORCE_COLOR;

  return {
    root,
    home,
    remoteHome,
    tmpDir: tmp,
    remoteTmpDir: remoteTmp,
    xdgConfigHome: xdgConfig,
    xdgCacheHome: xdgCache,
    xdgDataHome: xdgData,
    shimDir,
    commandLog,
    faultDir,
    env,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export async function runCcm(
  args: readonly string[],
  machineOrHome: FakeMachine | string,
  options: RunOptions = {},
): Promise<SubprocessResult> {
  const env =
    typeof machineOrHome === "string" ? await isolatedEnvForHome(machineOrHome) : machineOrHome.env;
  return runSubprocess(bunExecutable, [join(projectRoot, "src/index.ts"), ...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...env, ...options.env },
    input: options.input,
  });
}

export async function runCommand(
  command: string,
  args: readonly string[],
  machine: FakeMachine,
  options: RunOptions = {},
): Promise<SubprocessResult> {
  return runSubprocess(command, args, {
    cwd: options.cwd ?? machine.home,
    env: { ...machine.env, ...options.env },
    input: options.input,
  });
}

export async function readCommandLog(machine: FakeMachine): Promise<CommandLogEntry[]> {
  const raw = await readFile(machine.commandLog, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandLogEntry);
}

export async function clearCommandLog(machine: FakeMachine): Promise<void> {
  await writeFile(machine.commandLog, "", "utf8");
}

export function faultMarker(machine: FakeMachine, name: string, once = true): string {
  return join(machine.faultDir, `${encodeURIComponent(name)}.${once ? "once" : "always"}.json`);
}

export async function armFault(
  machine: FakeMachine,
  name: string,
  spec: FaultSpec = {},
  options: { once?: boolean } = {},
): Promise<string> {
  const marker = faultMarker(machine, name, options.once ?? true);
  await writeFile(marker, JSON.stringify({ exitCode: 70, ...spec }), "utf8");
  return marker;
}

async function isolatedEnvForHome(home: string): Promise<NodeJS.ProcessEnv> {
  const tmp = join(home, ".ccm-test-tmp");
  const xdgConfig = join(home, ".ccm-test-xdg", "config");
  const xdgCache = join(home, ".ccm-test-xdg", "cache");
  const xdgData = join(home, ".ccm-test-xdg", "data");
  await Promise.all(
    [tmp, xdgConfig, xdgCache, xdgData].map((path) => mkdir(path, { recursive: true })),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    NO_COLOR: "1",
  };
  delete env.FORCE_COLOR;
  return env;
}

async function runSubprocess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<SubprocessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) =>
      resolveResult({
        exitCode: exitCode ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function resolveBunExecutable(): Promise<string> {
  if (basename(process.execPath).startsWith("bun")) return realpath(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "bun");
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error("The integration harness requires a Bun executable");
}
