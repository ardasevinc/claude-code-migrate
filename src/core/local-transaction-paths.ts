import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BlockedError } from "../errors.ts";
import type { TransactionMember } from "./transaction-journal.ts";

export interface LocalTransactionRoot {
  readonly code: string;
  readonly path: string;
}

export interface LocalTransactionMemberPaths {
  readonly root: LocalTransactionRoot;
  readonly target: string;
  readonly workspace: string;
  readonly stage: string;
  readonly rollback: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!info.isDirectory()) throw new BlockedError("Transaction material has an unsafe type");
  for (const name of await readdir(path)) await syncTree(join(path, name));
  await syncDirectory(path);
}

async function assertPrivateCanonicalDirectory(path: string): Promise<void> {
  const lexical = resolve(path);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BlockedError("Transaction workspace parent is unsafe");
  if (process.getuid && info.uid !== process.getuid())
    throw new BlockedError("Transaction workspace parent is unowned");
  if ((info.mode & 0o022) !== 0)
    throw new BlockedError("Transaction workspace parent is writable by other users");
  if ((await realpath(lexical)) !== lexical)
    throw new BlockedError("Transaction workspace parent is not canonical");
}

export function transactionWorkspacePath(rootPath: string, transactionId: string): string {
  return join(dirname(rootPath), `.ccm-transaction-${transactionId.slice("txn_".length)}`);
}

export async function ensureTransactionWorkspace(
  rootPath: string,
  transactionId: string,
): Promise<string> {
  const parent = dirname(rootPath);
  await assertPrivateCanonicalDirectory(parent);
  const workspace = transactionWorkspacePath(rootPath, transactionId);
  let created = false;
  try {
    await mkdir(workspace, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const info = await lstat(workspace);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new BlockedError("Transaction workspace is unsafe");
  if (created) await syncDirectory(parent);
  return workspace;
}

export function resolveTransactionMemberPaths(
  roots: ReadonlyMap<string, LocalTransactionRoot>,
  transactionId: string,
  member: TransactionMember,
): LocalTransactionMemberPaths {
  const root = roots.get(member.rootCode);
  if (!root) throw new BlockedError(`Unknown transaction root: ${member.rootCode}`);
  if (
    member.targetRef === undefined ||
    member.stageRef === undefined ||
    member.rollbackRef === undefined
  )
    throw new BlockedError("Transaction member lacks recovery paths");
  const target = member.targetRef === "." ? root.path : join(root.path, member.targetRef);
  const rootResolved = resolve(root.path);
  const targetResolved = resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}/`))
    throw new BlockedError("Transaction target escapes its logical root");
  const workspace = transactionWorkspacePath(root.path, transactionId);
  return {
    root,
    target: targetResolved,
    workspace,
    stage: join(workspace, member.stageRef),
    rollback: join(workspace, member.rollbackRef),
  };
}

export async function durableRename(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  await syncDirectory(sourceParent);
  if (destinationParent !== sourceParent) await syncDirectory(destinationParent);
}

export async function durableRemove(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}
