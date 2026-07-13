import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { BlockedError, ExecutionError } from "../errors.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import {
  ProcessError,
  type ProcessOptions,
  type ProcessResult,
  runInheritedProcess,
  runProcess,
  runStreamingProcess,
} from "../utils/process.ts";
import { parseSshTarget } from "./ssh-target.ts";

const CONTROL_PERSIST_SECONDS = 600;

export interface SshSession {
  readonly host: string;
  run(
    command: string,
    options?: ProcessOptions,
    sshOptions?: readonly string[],
  ): Promise<ProcessResult>;
  upload(
    command: "scp" | "rsync",
    args: readonly string[],
    options?: ProcessOptions,
  ): Promise<ProcessResult>;
  streamRsync(args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
  close(): Promise<void>;
}

export function assertSshSessionHost(session: SshSession, host: string): void {
  if (session.host !== host)
    throw new BlockedError("SSH session target does not match requested host");
}

export async function createSshSession(host: string): Promise<SshSession> {
  parseSshTarget(host);
  // OpenSSH's Unix-domain control path is short on macOS; keep it under /tmp.
  const root = await mkdtemp(join("/tmp", "ccm-ssh-"));
  await chmod(root, 0o700);
  const controlPath = join(root, "control");
  const options = [
    "-oControlMaster=auto",
    `-oControlPersist=${CONTROL_PERSIST_SECONDS}`,
    `-oControlPath=${controlPath}`,
  ] as const;
  const rsyncShell = `ssh ${options.join(" ")}`;
  let closing: Promise<void> | undefined;
  let unregister = () => {};
  const closeOnce = async () => {
    unregister();
    const failures: ProcessError[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runProcess("ssh", [`-oControlPath=${controlPath}`, "-O", "exit", host], {
        nothrow: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0 && result.signal === null && !result.error) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      failures.push(new ProcessError("ssh", result));
      if (!(await lstat(controlPath).catch(() => null))) {
        await rm(root, { recursive: true, force: true });
        return;
      }
    }
    throw new ExecutionError("Could not close multiplexed SSH session; control socket retained", {
      cause: new AggregateError(failures),
    });
  };
  const close = () => (closing ??= closeOnce());
  unregister = registerInterruptCleanup(close);

  return {
    host,
    run: (command, processOptions = {}, sshOptions = []) =>
      runProcess("ssh", [...options, ...sshOptions, host, command], processOptions),
    upload: (command, args, processOptions = {}) =>
      runInheritedProcess(
        command,
        command === "scp" ? [...options, ...args] : [`--rsh=${rsyncShell}`, ...args],
        processOptions,
      ),
    streamRsync: (args, processOptions = {}) =>
      runStreamingProcess("rsync", [`--rsh=${rsyncShell}`, ...args], processOptions),
    close,
  };
}
