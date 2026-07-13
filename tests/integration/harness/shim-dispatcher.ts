import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [commandArg, ...args] = process.argv.slice(2);
const command = basename(commandArg ?? "");

appendLog({ command, args, cwd: process.cwd(), home: process.env.HOME ?? null });
const controlOperation = args.indexOf("-O");
const scopedFault =
  command === "ssh" && controlOperation !== -1 && args[controlOperation + 1] === "exit"
    ? "ssh:exit"
    : `${command}:${args[0] ?? ""}`;
applyFault(scopedFault) || applyFault(command);

switch (command) {
  case "claude":
    if (args.includes("--version") || args.includes("-v"))
      console.log(process.env.CCM_TEST_CLAUDE_VERSION ?? "1.0.0 (fake Claude)");
    break;
  case "codex":
    if (args.includes("--version") || args.includes("-v"))
      console.log(process.env.CCM_TEST_CODEX_VERSION ?? "codex-cli 0.0.0-fake");
    else if (args[0] === "plugin" && args[1] === "list" && args.includes("--json"))
      console.log(JSON.stringify({ installed: installedPlugins(), available: [] }));
    else if (args[0] === "plugin" && args[1] === "add" && args[2]) {
      const installed = new Set(installedPlugins());
      installed.add(args[2]);
      const path = installedPluginPath();
      writeFileSync(path, JSON.stringify([...installed].sort()), "utf8");
      if (args.includes("--json")) console.log("{}");
    }
    break;
  case "ssh":
    process.exitCode = runSsh(args);
    break;
  case "scp":
    copyTransport(args);
    break;
  case "rsync":
    copyTransport(args);
    break;
  default:
    console.error(`Unknown fake-machine command: ${command}`);
    process.exitCode = 127;
}

function appendLog(entry: object): void {
  const path = requiredEnv("CCM_TEST_COMMAND_LOG");
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

function applyFault(name: string): boolean {
  const root = requiredEnv("CCM_TEST_FAULT_DIR");
  for (const persistence of ["once", "always"] as const) {
    const marker = join(root, `${encodeURIComponent(name)}.${persistence}.json`);
    if (!existsSync(marker)) continue;
    const spec = JSON.parse(readFileSync(marker, "utf8")) as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    if (persistence === "once") rmSync(marker);
    if (spec.stdout) process.stdout.write(spec.stdout);
    if (spec.stderr) process.stderr.write(spec.stderr);
    process.exit(spec.exitCode ?? 70);
  }
  return false;
}

function runSsh(argv: string[]): number {
  const controlOperation = argv.indexOf("-O");
  if (controlOperation !== -1 && argv[controlOperation + 1] === "exit") return 0;
  const controlPath = argv
    .find((argument) => argument.startsWith("-oControlPath="))
    ?.slice("-oControlPath=".length);
  if (controlPath) writeFileSync(controlPath, "fake-control-socket", "utf8");
  const commandArgs = operandsAfterTarget(argv);
  const remoteHome = requiredEnv("CCM_TEST_REMOTE_HOME");
  const env = {
    ...process.env,
    HOME: remoteHome,
    TMPDIR: requiredEnv("CCM_TEST_REMOTE_TMPDIR"),
    XDG_CONFIG_HOME: join(remoteHome, ".config"),
    XDG_CACHE_HOME: join(remoteHome, ".cache"),
    XDG_DATA_HOME: join(remoteHome, ".local", "share"),
  };
  const invocation =
    commandArgs.length === 0
      ? ["/bin/sh"]
      : commandArgs.length === 1
        ? ["/bin/sh", "-c", commandArgs[0] as string]
        : commandArgs;
  if (
    commandArgs.some((argument) => argument.includes("OS=%s")) &&
    process.env.CCM_TEST_REMOTE_PROBE_PREFIX
  )
    process.stdout.write(process.env.CCM_TEST_REMOTE_PROBE_PREFIX);
  const result = Bun.spawnSync(invocation, {
    cwd: remoteHome,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode;
}

function operandsAfterTarget(argv: string[]): string[] {
  const optionsWithValue = new Set([
    "-b",
    "-c",
    "-D",
    "-E",
    "-F",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") return argv.slice(index + 2);
    if (optionsWithValue.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argv.slice(index + 1);
  }
  return [];
}

function copyTransport(argv: string[]): void {
  const operands = argv.filter((argument) => !argument.startsWith("-"));
  if (operands.length < 2) throw new Error(`${command} fixture requires source and destination`);
  const source = transportPath(operands.at(-2) as string);
  const destination = transportPath(operands.at(-1) as string);
  if (command === "rsync" && source.endsWith("/")) {
    cpSync(source, destination, { recursive: true, force: true });
    return;
  }
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function transportPath(value: string): string {
  const separator = value.indexOf(":");
  if (separator === -1) return value;
  const remotePath = value.slice(separator + 1);
  const remoteHome = requiredEnv("CCM_TEST_REMOTE_HOME");
  if (remotePath === "~") return remoteHome;
  if (remotePath.startsWith("~/")) return join(remoteHome, remotePath.slice(2));
  return remotePath;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing fake-machine environment variable: ${name}`);
  return value;
}

function installedPluginPath(): string {
  return join(requiredEnv("HOME"), ".ccm-test-installed-plugins.json");
}

function installedPlugins(): string[] {
  const path = installedPluginPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : [];
}
