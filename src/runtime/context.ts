import * as fs from "node:fs/promises";
import { homedir } from "node:os";

export interface RuntimeProcess {
  readonly cwd: () => string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface RuntimeFiles {
  readonly lstat: typeof fs.lstat;
  readonly readdir: typeof fs.readdir;
  readonly readFile: typeof fs.readFile;
  readonly readlink: typeof fs.readlink;
  readonly realpath: typeof fs.realpath;
  readonly stat: typeof fs.stat;
}

export interface RuntimeContext {
  readonly home: string;
  readonly now: () => Date;
  readonly process: RuntimeProcess;
  readonly files: RuntimeFiles;
}

export function createRuntimeContext(
  overrides: Partial<Pick<RuntimeContext, "home" | "now" | "process" | "files">> = {},
): RuntimeContext {
  return {
    home: overrides.home ?? homedir(),
    now: overrides.now ?? (() => new Date()),
    process: overrides.process ?? { cwd: () => process.cwd(), env: process.env },
    files: overrides.files ?? fs,
  };
}
