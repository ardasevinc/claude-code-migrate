import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { BlockedError } from "../errors.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";
import type { TransactionTargetKind } from "./transaction-journal.ts";

const MAX_ENTRIES = 50_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

interface FingerprintEntry {
  readonly path: string;
  readonly kind: Exclude<TransactionTargetKind, "absent">;
  readonly mode: number;
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
}

export interface LocalPathFingerprint {
  readonly kind: TransactionTargetKind;
  readonly fingerprint: PlanFingerprint;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const bytesCompare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

async function hashFile(
  path: string,
): Promise<{ readonly mode: number; readonly size: number; readonly sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new BlockedError("Transaction path changed type while hashing");
    if (before.size > BigInt(MAX_BYTES))
      throw new BlockedError("Transaction path exceeds the fingerprint byte limit");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_BYTES)
        throw new BlockedError("Transaction path exceeds the fingerprint byte limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(offset) !== after.size
    )
      throw new BlockedError("Transaction path changed while hashing");
    return { mode: Number(before.mode & 0o777n), size: offset, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function collect(
  absolute: string,
  relative: string,
  entries: FingerprintEntry[],
  total: { bytes: number },
): Promise<void> {
  if (entries.length >= MAX_ENTRIES)
    throw new BlockedError("Transaction tree exceeds the fingerprint entry limit");
  const before = await lstat(absolute, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  if (before.isSymbolicLink()) {
    const target = await readlink(absolute);
    const after = await lstat(absolute, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs
    )
      throw new BlockedError("Transaction symlink changed while hashing");
    total.bytes += Buffer.byteLength(target);
    if (total.bytes > MAX_BYTES)
      throw new BlockedError("Transaction tree exceeds the fingerprint byte limit");
    entries.push({ path: relative, kind: "symlink", mode, target });
    return;
  }
  if (before.isFile()) {
    const hashed = await hashFile(absolute);
    total.bytes += hashed.size;
    if (total.bytes > MAX_BYTES)
      throw new BlockedError("Transaction tree exceeds the fingerprint byte limit");
    entries.push({ path: relative, kind: "file", ...hashed });
    return;
  }
  if (!before.isDirectory()) throw new BlockedError("Transaction tree contains an unsafe type");
  entries.push({ path: relative, kind: "directory", mode });
  const names = await readdir(absolute);
  names.sort(bytesCompare);
  for (const name of names)
    await collect(
      join(absolute, name),
      relative === "." ? name : `${relative}/${name}`,
      entries,
      total,
    );
  const afterNames = await readdir(absolute);
  afterNames.sort(bytesCompare);
  const after = await lstat(absolute, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.mtimeNs !== after.mtimeNs ||
    names.length !== afterNames.length ||
    names.some((name, index) => name !== afterNames[index])
  )
    throw new BlockedError("Transaction directory changed while hashing");
}

export async function fingerprintLocalPath(path: string): Promise<LocalPathFingerprint> {
  try {
    await lstat(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return {
      kind: "absent",
      fingerprint: fingerprint("local-transaction-tree-v1", { absent: true }),
    };
  }
  const entries: FingerprintEntry[] = [];
  try {
    await collect(path, ".", entries, { bytes: 0 });
  } catch (error) {
    if (isNodeError(error, "ENOENT"))
      throw new BlockedError("Transaction tree changed while hashing", { cause: error });
    throw error;
  }
  const root = entries[0];
  if (!root) throw new Error("Transaction fingerprint is empty");
  return {
    kind: root.kind,
    fingerprint: fingerprint(
      "local-transaction-tree-v1",
      entries.map(({ path: relative, kind, mode, size, sha256, target }) => ({
        path: relative,
        kind,
        mode,
        ...(size === undefined ? {} : { size }),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(target === undefined ? {} : { target }),
      })),
    ),
  };
}
