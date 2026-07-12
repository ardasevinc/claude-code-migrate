import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { BlockedError } from "../errors.ts";

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 4;

type NativeRenameLibrary = {
  readonly renameNoReplaceAt: (
    source: Uint8Array,
    destinationDirectoryFd: number,
    destination: Uint8Array,
  ) => number;
};

export interface OpenDirectoryBinding {
  readonly fd: number;
  /** Used only by the explicit Vitest fallback; Bun binds the descriptor. */
  readonly path: string;
}

let library: Promise<NativeRenameLibrary> | undefined;

function libraryCandidates(): readonly string[] {
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

function renameAt2SyscallNumber(): number | undefined {
  if (process.arch === "arm64") return 276;
  if (process.arch === "x64") return 316;
  return undefined;
}

async function nativeLibrary(): Promise<NativeRenameLibrary> {
  library ??= import("bun:ffi").then(({ dlopen }) => {
    const failures: unknown[] = [];
    for (const candidate of libraryCandidates()) {
      try {
        if (process.platform === "darwin") {
          const opened = dlopen(candidate, {
            renameatx_np: {
              args: ["i32", "buffer", "i32", "buffer", "u32"],
              returns: "i32",
            },
          });
          return {
            renameNoReplaceAt: (source, destinationDirectoryFd, destination) =>
              opened.symbols.renameatx_np(
                AT_FDCWD,
                source,
                destinationDirectoryFd,
                destination,
                RENAME_EXCL,
              ),
          };
        }
        try {
          const opened = dlopen(candidate, {
            renameat2: {
              args: ["i32", "buffer", "i32", "buffer", "u32"],
              returns: "i32",
            },
          });
          return {
            renameNoReplaceAt: (source, destinationDirectoryFd, destination) =>
              opened.symbols.renameat2(
                AT_FDCWD,
                source,
                destinationDirectoryFd,
                destination,
                RENAME_NOREPLACE,
              ),
          };
        } catch (error) {
          failures.push(error);
        }
        const syscallNumber = renameAt2SyscallNumber();
        if (syscallNumber === undefined) continue;
        const opened = dlopen(candidate, {
          syscall: {
            args: ["i64", "i64", "buffer", "i64", "buffer", "i64"],
            returns: "i64",
          },
        });
        return {
          renameNoReplaceAt: (source, destinationDirectoryFd, destination) =>
            Number(
              opened.symbols.syscall(
                BigInt(syscallNumber),
                BigInt(destinationDirectoryFd),
                source,
                BigInt(AT_FDCWD),
                destination,
                BigInt(RENAME_NOREPLACE),
              ),
            ),
        };
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      `Atomic no-replace rename is unsupported on ${process.platform}/${process.arch}`,
    );
  });
  return library;
}

function cPath(path: string): Buffer {
  if (path.includes("\0")) throw new BlockedError("Transaction path contains a null byte");
  return Buffer.from(`${path}\0`, "utf8");
}

export async function renameNoReplace(source: string, destination: string): Promise<void> {
  if (typeof globalThis.Bun === "undefined") {
    if (process.env.VITEST !== "true") throw new Error("Atomic no-replace rename requires Bun");
    try {
      await import("node:fs/promises").then(({ lstat }) => lstat(destination));
      throw new BlockedError("Transaction target appeared before commit");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(source, destination);
    return;
  }
  const native = await nativeLibrary();
  if (native.renameNoReplaceAt(cPath(source), AT_FDCWD, cPath(destination)) !== 0)
    throw new BlockedError("Atomic no-replace rename failed; transaction target may have changed");
}

export async function renameNoReplaceAt(
  source: string,
  destinationDirectory: OpenDirectoryBinding,
  destinationName: string,
): Promise<void> {
  if (
    basename(destinationName) !== destinationName ||
    destinationName === "." ||
    destinationName === ".."
  )
    throw new BlockedError("Atomic rename destination must be one path component");
  if (typeof globalThis.Bun === "undefined") {
    if (process.env.VITEST !== "true") throw new Error("Atomic no-replace rename requires Bun");
    try {
      await import("node:fs/promises").then(({ lstat }) =>
        lstat(join(destinationDirectory.path, destinationName)),
      );
      throw new BlockedError("Transaction target appeared before commit");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(source, join(destinationDirectory.path, destinationName));
    return;
  }
  const native = await nativeLibrary();
  const nativeDirectoryFd = process.platform === "linux" ? AT_FDCWD : destinationDirectory.fd;
  const nativeDestination =
    process.platform === "linux"
      ? `/proc/self/fd/${destinationDirectory.fd}/${destinationName}`
      : destinationName;
  if (native.renameNoReplaceAt(cPath(source), nativeDirectoryFd, cPath(nativeDestination)) !== 0)
    throw new BlockedError("Atomic no-replace rename failed; transaction target may have changed");
}
