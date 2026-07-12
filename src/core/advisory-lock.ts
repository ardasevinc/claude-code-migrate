import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { BlockedError } from "../errors.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const nodeTestLocks = new Set<string>();

type FlockLibrary = {
  readonly symbols: {
    flock(fd: number, operation: number): number;
  };
};

let library: Promise<FlockLibrary> | undefined;

function flockLibraryCandidates(): readonly string[] {
  if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (process.platform !== "linux") return [];
  const muslArch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return [
    "libc.so.6",
    `/lib/libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
    "libc.so",
  ];
}

async function flockLibrary(): Promise<FlockLibrary> {
  library ??= import("bun:ffi").then(({ dlopen }) => {
    const failures: unknown[] = [];
    for (const candidate of flockLibraryCandidates()) {
      try {
        return dlopen(candidate, {
          flock: { args: ["i32", "i32"], returns: "i32" },
        });
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      `Kernel advisory locks are unsupported on ${process.platform}/${process.arch}`,
    );
  });
  return library;
}

export class AdvisoryLockReleaseError extends Error {
  constructor(cause: unknown) {
    super("Kernel advisory lock release failed", { cause });
    this.name = "AdvisoryLockReleaseError";
  }
}

export class AdvisoryLockOperationAndReleaseError extends AggregateError {
  readonly operationError: unknown;
  readonly releaseError: unknown;

  constructor(operationError: unknown, releaseError: unknown) {
    super([operationError, releaseError], "Locked operation and release failed");
    this.name = "AdvisoryLockOperationAndReleaseError";
    this.operationError = operationError;
    this.releaseError = releaseError;
  }
}

/** Holds a kernel advisory lock for the complete async callback. The kernel releases it on crash. */
export async function withAdvisoryFileLock<T>(
  path: string,
  callback: () => Promise<T>,
): Promise<T> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const testKey = resolve(path);
  let locked = false;
  let testLocked = false;
  let ffi: FlockLibrary | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600)
      throw new Error("Unsafe CCM advisory lock file");
    if (process.getuid && info.uid !== process.getuid())
      throw new Error("Unowned CCM advisory lock file");
    if (typeof globalThis.Bun === "undefined") {
      if (process.env.VITEST !== "true") throw new Error("Kernel advisory locks require Bun");
      if (nodeTestLocks.has(testKey))
        throw new BlockedError("Another CCM transaction writer is active");
      nodeTestLocks.add(testKey);
      testLocked = true;
    } else {
      ffi = await flockLibrary();
      if (ffi.symbols.flock(handle.fd, LOCK_EX | LOCK_NB) !== 0)
        throw new BlockedError("Another CCM transaction writer is active");
      locked = true;
    }
    result = await callback();
  } catch (error) {
    primaryError = error;
  }
  let releaseError: unknown;
  if (locked && ffi && ffi.symbols.flock(handle.fd, LOCK_UN) !== 0)
    releaseError = new Error("flock unlock failed");
  if (testLocked) nodeTestLocks.delete(testKey);
  try {
    await handle.close();
  } catch (error) {
    releaseError = releaseError
      ? new AggregateError([releaseError, error], "Unlock and close failed")
      : error;
  }
  if (primaryError && releaseError)
    throw new AdvisoryLockOperationAndReleaseError(primaryError, releaseError);
  if (primaryError) throw primaryError;
  if (releaseError) throw new AdvisoryLockReleaseError(releaseError);
  return result as T;
}
