import { spawn } from "node:child_process";
import { registerInterruptCleanup } from "./interrupt-cleanup.ts";

const INTERRUPT_GRACE_MS = 250;

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nothrow?: boolean;
  maxBuffer?: number;
  timeoutMs?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export class ProcessError extends Error {
  readonly command: string;
  readonly result: ProcessResult;

  constructor(command: string, result: ProcessResult, cause?: unknown) {
    const status = result.signal ?? result.exitCode ?? "spawn error";
    const detailMessage = result.error ?? (cause instanceof Error ? cause.message : undefined);
    const detail = detailMessage ? `: ${detailMessage}` : "";
    super(`Process failed (${status}): ${command}${detail}`, { cause });
    this.name = "ProcessError";
    this.command = command;
    this.result = result;
  }
}

export async function runProcess(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return executeProcess(command, args, options, "pipe");
}

export async function runInheritedProcess(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return executeProcess(command, args, options, "inherit");
}

async function executeProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
  stdio: "pipe" | "inherit",
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
    let bufferedBytes = 0;
    let bufferError: string | undefined;
    let timeoutError: string | undefined;
    let settled = false;
    let childClosed = false;
    let resolveChildClosed: () => void;
    const childClosedPromise = new Promise<void>((resolve) => {
      resolveChildClosed = resolve;
    });
    const unregisterInterruptCleanup = registerInterruptCleanup(async () => {
      if (childClosed) return;

      child.kill("SIGTERM");
      const timedOut = await Promise.race([
        childClosedPromise.then(() => false),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), INTERRUPT_GRACE_MS)),
      ]);
      if (timedOut && !childClosed) {
        child.kill("SIGKILL");
        await childClosedPromise;
      }
    });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (childClosed) return;
            timeoutError = `process timed out after ${options.timeoutMs}ms`;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!childClosed) child.kill("SIGKILL");
            }, INTERRUPT_GRACE_MS).unref();
          }, options.timeoutMs);
    timeout?.unref();

    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (settled || bufferError) return;
      bufferedBytes += chunk.length;
      if (bufferedBytes > maxBuffer) {
        bufferError = `output exceeded ${maxBuffer} byte buffer limit`;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const finish = (result: ProcessResult, cause?: unknown) => {
      if (settled) return;
      settled = true;

      if (result.exitCode === 0 && result.signal === null) {
        resolve(result);
      } else if (options.nothrow) {
        resolve(result);
      } else {
        reject(new ProcessError(command, result, cause));
      }
    };

    child.on("error", (error) => {
      childClosed = true;
      resolveChildClosed();
      unregisterInterruptCleanup();
      if (timeout) clearTimeout(timeout);
      finish({ stdout: "", stderr: "", exitCode: null, signal: null, error: error.message }, error);
    });
    child.on("close", (exitCode, signal) => {
      childClosed = true;
      resolveChildClosed();
      unregisterInterruptCleanup();
      if (timeout) clearTimeout(timeout);
      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode,
        signal,
        ...(bufferError || timeoutError ? { error: bufferError ?? timeoutError } : {}),
      };
      finish(result, result.error ? new Error(result.error) : undefined);
    });
  });
}
