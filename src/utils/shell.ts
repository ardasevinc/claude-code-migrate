import type { ExecException, ExecOptions } from "node:child_process";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);

export interface ShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  nothrow?: boolean;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// child_process.exec buffers full stdio in memory; on huge output it rejects with
// MAXBUFFER and captured output may be truncated.
const MAX_BUFFER = 20 * 1024 * 1024;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function runCommand(
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> {
  try {
    const result = await exec(command, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: MAX_BUFFER,
    } satisfies ExecOptions);

    const stdout = toText(result.stdout);
    const stderr = toText(result.stderr);

    if (!options.quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }

    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as ExecException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    const stdout = toText(execError.stdout);
    const stderr = toText(execError.stderr);
    const exitCode = typeof execError.code === "number" ? execError.code : 1;

    if (!options.quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }

    if (!options.nothrow) {
      const details = stderr || stdout || execError.message;
      throw new Error(`Command failed (${exitCode}): ${command}\n${details}`);
    }

    return { stdout, stderr, exitCode };
  }
}

function toText(value: string | Buffer | undefined): string {
  if (!value) {
    return "";
  }

  return typeof value === "string" ? value : value.toString();
}
