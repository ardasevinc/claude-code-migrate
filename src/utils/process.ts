import { spawn } from "node:child_process";

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nothrow?: boolean;
  maxBuffer?: number;
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
    let settled = false;

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
      finish({ stdout: "", stderr: "", exitCode: null, signal: null, error: error.message }, error);
    });
    child.on("close", (exitCode, signal) => {
      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode,
        signal,
        ...(bufferError ? { error: bufferError } : {}),
      };
      finish(result, bufferError ? new Error(bufferError) : undefined);
    });
  });
}
