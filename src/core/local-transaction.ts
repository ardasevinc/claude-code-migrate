import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BlockedError, ExecutionError } from "../errors.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { fingerprintLocalPath } from "./local-transaction-fingerprint.ts";
import {
  durableRemove,
  durableRename,
  ensureTransactionWorkspace,
  type LocalTransactionRoot,
  pathExists,
  resolveTransactionMemberPaths,
  syncDirectory,
  syncTree,
} from "./local-transaction-paths.ts";
import { renameNoReplace, renameNoReplaceAt } from "./native-rename.ts";
import {
  createTransactionJournal,
  deleteTerminalTransactionJournal,
  JournalPublicationAmbiguousError,
  listTransactionJournals,
  publishTransactionJournal,
  readTransactionJournal,
  type TransactionJournal,
  type TransactionMember,
  transitionTransactionJournal,
  withTransactionMutationLock,
} from "./transaction-journal.ts";

export interface LocalTransactionRootBinding extends LocalTransactionRoot {
  readonly allowWholeExisting?: boolean;
}

export interface LocalTransactionMemberInput {
  readonly id: string;
  readonly rootCode: string;
  /** A single top-level entry, or `.` when the logical root itself is the member. */
  readonly targetRef: string;
  readonly materialize: (stagePath: string) => Promise<void>;
}

export interface ExecuteLocalTransactionOptions {
  readonly context: RuntimeContext;
  readonly planId: string;
  readonly roots: readonly LocalTransactionRootBinding[];
  readonly members: readonly LocalTransactionMemberInput[];
  readonly verify: () => Promise<void>;
  readonly afterBoundary?: (boundary: string, journal: TransactionJournal) => Promise<void>;
  /** Test seam immediately before the atomic absent-target rename syscall. */
  readonly beforeAbsentRename?: (targetPath: string) => Promise<void>;
}

class InterruptRequestedError extends Error {}
class RecoveryInferenceError extends Error {}

const settled = Promise.resolve();

function nextTimestamp(context: RuntimeContext, journal: TransactionJournal): Date {
  const observed = context.now();
  const previous = new Date(journal.updatedAt).getTime();
  return observed.getTime() <= previous ? new Date(previous + 1) : observed;
}

function sameJournal(left: TransactionJournal, right: TransactionJournal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function publishReconciled(
  context: RuntimeContext,
  previous: TransactionJournal | undefined,
  candidate: TransactionJournal,
): Promise<TransactionJournal> {
  try {
    await publishTransactionJournal(context, candidate, previous?.revision ?? null);
    return candidate;
  } catch (error) {
    if (!(error instanceof JournalPublicationAmbiguousError)) throw error;
    let current: TransactionJournal;
    try {
      current = await readTransactionJournal(context, candidate.id);
    } catch (readError) {
      throw new ExecutionError(`Transaction journal needs reconciliation: ${candidate.id}`, {
        cause: new AggregateError([error, readError]),
      });
    }
    if (sameJournal(current, candidate)) return current;
    if (previous && sameJournal(current, previous)) throw error;
    throw new ExecutionError(`Transaction journal advanced unexpectedly: ${candidate.id}`, {
      cause: error,
    });
  }
}

async function transitionAndPublish(
  context: RuntimeContext,
  journal: TransactionJournal,
  state: Parameters<typeof transitionTransactionJournal>[1],
  patch: Parameters<typeof transitionTransactionJournal>[3] = {},
): Promise<TransactionJournal> {
  const candidate = transitionTransactionJournal(
    journal,
    state,
    nextTimestamp(context, journal),
    patch,
  );
  return publishReconciled(context, journal, candidate);
}

async function canonicalRootPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new BlockedError("Local transaction roots must be absolute");
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

async function rootMap(
  roots: readonly LocalTransactionRootBinding[],
): Promise<Map<string, LocalTransactionRootBinding>> {
  const mapped = new Map<string, LocalTransactionRootBinding>();
  for (const root of roots) {
    if (mapped.has(root.code)) throw new Error(`Duplicate local transaction root: ${root.code}`);
    mapped.set(root.code, { ...root, path: await canonicalRootPath(root.path) });
  }
  const physical = [...mapped.values()].map((root) => ({
    code: root.code,
    path: resolve(root.path).normalize("NFC").toLocaleLowerCase("en-US"),
  }));
  for (let leftIndex = 0; leftIndex < physical.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < physical.length; rightIndex += 1) {
      const left = physical[leftIndex] as { code: string; path: string };
      const right = physical[rightIndex] as { code: string; path: string };
      if (
        left.path === right.path ||
        left.path.startsWith(`${right.path}/`) ||
        right.path.startsWith(`${left.path}/`)
      )
        throw new BlockedError(`Local transaction roots overlap: ${left.code}, ${right.code}`);
    }
  }
  return mapped;
}

async function chooseBackupRefs(
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  members: readonly LocalTransactionMemberInput[],
  start: number,
): Promise<ReadonlyMap<string, string>> {
  const refs = new Map<string, string>();
  let candidate = start;
  for (const code of new Set(members.map((member) => member.rootCode))) {
    const root = roots.get(code);
    if (!root) throw new BlockedError(`Unknown local transaction root: ${code}`);
    while (await pathExists(`${root.path}.backup-${candidate}`)) candidate += 1;
    refs.set(code, String(candidate));
    candidate += 1;
  }
  return refs;
}

async function assertMemberShape(
  root: LocalTransactionRootBinding,
  input: LocalTransactionMemberInput,
): Promise<void> {
  if (input.targetRef !== "." && input.targetRef.includes("/"))
    throw new BlockedError("Local transaction members must be non-overlapping top-level entries");
  const rootState = await fingerprintLocalPath(root.path);
  if (rootState.kind === "absent" && input.targetRef !== ".")
    throw new BlockedError("An absent logical root must be committed as one member");
  if (rootState.kind === "directory" && input.targetRef === "." && !root.allowWholeExisting)
    throw new BlockedError("Existing provider roots cannot be swapped as one member");
  if (rootState.kind !== "absent" && rootState.kind !== "directory" && input.targetRef !== ".")
    throw new BlockedError("Transaction logical root has an unsafe type");
}

async function openBackupRoot(path: string): Promise<FileHandle> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  if (created) await syncDirectory(dirname(path));
  const lexical = await lstat(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      lexical.dev !== info.dev ||
      lexical.ino !== info.ino ||
      !info.isDirectory() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw new BlockedError("Transaction backup root is unsafe");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectoryHandlePath(handle: FileHandle, path: string): Promise<void> {
  const [bound, lexical] = await Promise.all([handle.stat(), lstat(path)]);
  if (
    !bound.isDirectory() ||
    !lexical.isDirectory() ||
    lexical.isSymbolicLink() ||
    bound.dev !== lexical.dev ||
    bound.ino !== lexical.ino
  )
    throw new BlockedError("Transaction backup root changed during finalization");
}

async function finalizeCommittedMember(
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  journal: TransactionJournal,
  member: TransactionMember,
): Promise<void> {
  const paths = resolveTransactionMemberPaths(roots, journal.id, member);
  if (
    member.preimageFingerprint === undefined ||
    member.backupRef === undefined ||
    member.originalKind === undefined ||
    member.targetRef === undefined
  )
    throw new BlockedError("Committed transaction lacks backup metadata");
  const backupRoot = `${paths.root.path}.backup-${member.backupRef}`;
  const destination =
    member.targetRef === "." ? backupRoot : join(backupRoot, member.targetRef as string);
  if (!(await pathExists(paths.rollback))) {
    if (member.originalKind === "absent") return;
    if (member.targetRef === ".") {
      if ((await fingerprintLocalPath(destination)).fingerprint !== member.preimageFingerprint)
        throw new BlockedError("Committed transaction lost its rollback material");
    } else {
      const handle = await openBackupRoot(backupRoot);
      try {
        if ((await fingerprintLocalPath(destination)).fingerprint !== member.preimageFingerprint)
          throw new BlockedError("Committed transaction lost its rollback material");
        await assertDirectoryHandlePath(handle, backupRoot);
      } finally {
        await handle.close();
      }
    }
    return;
  }
  const rollback = await fingerprintLocalPath(paths.rollback);
  if (rollback.fingerprint !== member.preimageFingerprint)
    throw new BlockedError("Transaction rollback material changed before backup finalization");
  if (member.targetRef === ".") {
    await renameNoReplace(paths.rollback, destination);
    await syncDirectory(dirname(paths.rollback));
    if (dirname(destination) !== dirname(paths.rollback)) await syncDirectory(dirname(destination));
    return;
  }
  const handle = await openBackupRoot(backupRoot);
  try {
    await renameNoReplaceAt(paths.rollback, { fd: handle.fd, path: backupRoot }, member.targetRef);
    await syncDirectory(dirname(paths.rollback));
    await handle.sync();
    await assertDirectoryHandlePath(handle, backupRoot);
  } finally {
    await handle.close();
  }
}

async function cleanupWorkspaces(
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  journal: TransactionJournal,
): Promise<void> {
  const workspaces = new Set(
    [...roots.values()].map((root) =>
      join(dirname(root.path), `.ccm-transaction-${journal.id.slice("txn_".length)}`),
    ),
  );
  for (const workspace of workspaces) await durableRemove(workspace);
}

async function finalizeTerminalJournal(
  context: RuntimeContext,
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  journal: TransactionJournal,
): Promise<void> {
  if (journal.state === "committed")
    for (const member of journal.members) await finalizeCommittedMember(roots, journal, member);
  await cleanupWorkspaces(roots, journal);
  await deleteTerminalTransactionJournal(context, journal.id, journal.revision);
}

async function inferAndRollbackMember(
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  journal: TransactionJournal,
  member: TransactionMember,
): Promise<void> {
  if (
    member.targetRef === undefined ||
    member.originalKind === undefined ||
    member.preimageFingerprint === undefined ||
    member.postimageFingerprint === undefined
  )
    throw new RecoveryInferenceError("Transaction member lacks restart metadata");
  const paths = resolveTransactionMemberPaths(roots, journal.id, member);
  const [target, stage, rollback] = await Promise.all([
    fingerprintLocalPath(paths.target),
    fingerprintLocalPath(paths.stage),
    fingerprintLocalPath(paths.rollback),
  ]);
  if (member.originalKind === "absent") {
    if (rollback.kind !== "absent")
      throw new RecoveryInferenceError("Absent target unexpectedly has rollback material");
    if (target.kind !== "absent" && target.fingerprint !== member.postimageFingerprint)
      throw new RecoveryInferenceError("Absent transaction target contains external state");
    if (target.kind !== "absent") await durableRemove(paths.target);
    if (stage.kind !== "absent") await durableRemove(paths.stage);
    return;
  }
  if (rollback.kind === "absent") {
    if (target.fingerprint !== member.preimageFingerprint)
      throw new RecoveryInferenceError("Original target lost without rollback material");
    if (stage.kind !== "absent") await durableRemove(paths.stage);
    return;
  }
  if (rollback.fingerprint !== member.preimageFingerprint)
    throw new RecoveryInferenceError("Rollback material does not match the original target");
  if (target.kind !== "absent" && target.fingerprint !== member.postimageFingerprint)
    throw new RecoveryInferenceError("Transaction target contains external state");
  if (target.kind !== "absent") await durableRemove(paths.target);
  await durableRename(paths.rollback, paths.target);
  if (stage.kind !== "absent") await durableRemove(paths.stage);
}

async function rollbackJournal(
  context: RuntimeContext,
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
  supplied: TransactionJournal,
): Promise<TransactionJournal> {
  let journal = await readTransactionJournal(context, supplied.id);
  if (journal.state === "committed" || journal.state === "rolled_back") return journal;
  const members = journal.members.map((member) =>
    member.state === "pending" ? { ...member, state: "untouched" as const } : member,
  );
  if (journal.state !== "rolling_back")
    journal = await transitionAndPublish(context, journal, "rolling_back", {
      members,
      terminalErrorCode: null,
    });
  try {
    for (const member of [...journal.members].reverse()) {
      if (member.state === "untouched") continue;
      await inferAndRollbackMember(roots, journal, member);
    }
  } catch (error) {
    const recovery = await transitionAndPublish(context, journal, "recovery_required", {
      terminalErrorCode: "ambiguous-filesystem-state",
    });
    throw new ExecutionError(`Transaction requires recovery: ${recovery.id}`, { cause: error });
  }
  journal = await transitionAndPublish(context, journal, "rolled_back", {
    members: journal.members.map((member) =>
      member.state === "untouched" ? member : { ...member, state: "rolled_back" as const },
    ),
  });
  return journal;
}

async function maintainExistingJournals(
  context: RuntimeContext,
  roots: ReadonlyMap<string, LocalTransactionRootBinding>,
): Promise<void> {
  for (const journal of await listTransactionJournals(context)) {
    if (journal.state === "committed" || journal.state === "rolled_back") {
      await finalizeTerminalJournal(context, roots, journal);
      continue;
    }
    if (journal.state === "planning") {
      const rolledBack = await rollbackJournal(context, roots, journal);
      await finalizeTerminalJournal(context, roots, rolledBack);
      continue;
    }
    throw new BlockedError(`Incomplete CCM transaction requires recovery: ${journal.id}`);
  }
}

async function executeLocked(options: ExecuteLocalTransactionOptions): Promise<TransactionJournal> {
  const roots = await rootMap(options.roots);
  await maintainExistingJournals(options.context, roots);
  for (const input of options.members) {
    const root = roots.get(input.rootCode);
    if (!root) throw new BlockedError(`Unknown local transaction root: ${input.rootCode}`);
    await assertMemberShape(root, input);
  }
  let journal = createTransactionJournal({
    kind: "restore",
    planId: options.planId,
    now: options.context.now(),
    members: options.members.map(({ id, rootCode }) => ({ id, rootCode })),
  });
  journal = await publishReconciled(options.context, undefined, journal);
  let interrupted = false;
  let activeStep: Promise<void> = settled;
  let rollbackPromise: Promise<TransactionJournal> | undefined;
  const runStep = async (operation: () => Promise<void>): Promise<void> => {
    if (interrupted) throw new InterruptRequestedError("Transaction interrupted");
    const step = operation();
    activeStep = step;
    try {
      await step;
    } finally {
      activeStep = settled;
    }
    if (interrupted) throw new InterruptRequestedError("Transaction interrupted");
  };
  const rollbackOnce = () => {
    rollbackPromise ??= activeStep
      .catch(() => {})
      .then(() => rollbackJournal(options.context, roots, journal));
    return rollbackPromise;
  };
  const unregister = registerInterruptCleanup(async () => {
    interrupted = true;
    await rollbackOnce();
  });
  try {
    await options.afterBoundary?.("journal:planning", journal);
    const backupRefs = await chooseBackupRefs(
      roots,
      options.members,
      new Date(journal.createdAt).getTime(),
    );
    const prepared: TransactionMember[] = [];
    for (const [index, input] of options.members.entries()) {
      const root = roots.get(input.rootCode) as LocalTransactionRootBinding;
      const stageRef = `stage-${index}`;
      const rollbackRef = `rollback-${index}`;
      const provisional: TransactionMember = {
        id: input.id,
        rootCode: input.rootCode,
        state: "snapshotted",
        stageRef,
        rollbackRef,
        targetRef: input.targetRef,
        originalKind: "absent",
        preimageFingerprint: `fp_${"0".repeat(64)}`,
        postimageFingerprint: `fp_${"0".repeat(64)}`,
        backupRef: backupRefs.get(input.rootCode) as string,
      };
      const paths = resolveTransactionMemberPaths(roots, journal.id, provisional);
      await runStep(async () => {
        await ensureTransactionWorkspace(root.path, journal.id);
        if ((await pathExists(paths.stage)) || (await pathExists(paths.rollback)))
          throw new BlockedError("Transaction material already exists");
        const preimage = await fingerprintLocalPath(paths.target);
        await input.materialize(paths.stage);
        await syncTree(paths.stage);
        await syncDirectory(paths.workspace);
        const postimage = await fingerprintLocalPath(paths.stage);
        const workspaceInfo = await import("node:fs/promises").then(({ lstat }) =>
          lstat(paths.workspace),
        );
        const targetParent = input.targetRef === "." ? dirname(root.path) : root.path;
        const targetParentInfo = await import("node:fs/promises").then(({ lstat }) =>
          lstat(targetParent),
        );
        if (workspaceInfo.dev !== targetParentInfo.dev)
          throw new BlockedError("Transaction workspace is not on the target filesystem");
        prepared.push({
          ...provisional,
          originalKind: preimage.kind,
          preimageFingerprint: preimage.fingerprint,
          postimageFingerprint: postimage.fingerprint,
        });
      });
      await options.afterBoundary?.(`materialized:${input.id}`, journal);
    }
    await runStep(async () => {
      journal = await transitionAndPublish(options.context, journal, "preparing", {
        members: prepared,
      });
    });
    await options.afterBoundary?.("journal:preparing", journal);
    await runStep(async () => {
      journal = await transitionAndPublish(options.context, journal, "prepared");
    });
    await options.afterBoundary?.("journal:prepared", journal);
    for (const member of journal.members) {
      const paths = resolveTransactionMemberPaths(roots, journal.id, member);
      const current = await fingerprintLocalPath(paths.target);
      if (current.fingerprint !== member.preimageFingerprint)
        throw new BlockedError("Transaction target changed after preparation");
    }
    await runStep(async () => {
      journal = await transitionAndPublish(options.context, journal, "committing");
    });
    await options.afterBoundary?.("journal:committing", journal);
    for (const member of journal.members) {
      const paths = resolveTransactionMemberPaths(roots, journal.id, member);
      await runStep(async () => {
        const [target, stage] = await Promise.all([
          fingerprintLocalPath(paths.target),
          fingerprintLocalPath(paths.stage),
        ]);
        if (target.fingerprint !== member.preimageFingerprint)
          throw new BlockedError("Transaction target changed before commit");
        if (stage.fingerprint !== member.postimageFingerprint || stage.kind === "absent")
          throw new BlockedError("Transaction stage changed before commit");
        if (member.originalKind === "absent") {
          await options.beforeAbsentRename?.(paths.target);
          await renameNoReplace(paths.stage, paths.target);
          await syncDirectory(dirname(paths.stage));
          if (dirname(paths.target) !== dirname(paths.stage))
            await syncDirectory(dirname(paths.target));
        } else await durableRename(paths.target, paths.rollback);
      });
      if (member.originalKind !== "absent") {
        await options.afterBoundary?.(`renamed:rollback:${member.id}`, journal);
        await runStep(async () => {
          await durableRename(paths.stage, paths.target);
        });
      }
      await options.afterBoundary?.(`renamed:commit:${member.id}`, journal);
    }
    await runStep(options.verify);
    for (const member of journal.members) {
      const paths = resolveTransactionMemberPaths(roots, journal.id, member);
      if ((await fingerprintLocalPath(paths.target)).fingerprint !== member.postimageFingerprint)
        throw new ExecutionError("Transaction target does not match the staged postimage");
    }
    await runStep(async () => {
      journal = await transitionAndPublish(options.context, journal, "committed", {
        members: journal.members.map((member) => ({ ...member, state: "committed" as const })),
      });
    });
    unregister();
    await finalizeTerminalJournal(options.context, roots, journal);
    return journal;
  } catch (error) {
    if (journal.state === "committed") {
      unregister();
      throw new ExecutionError(
        `Transaction committed but terminal maintenance is pending: ${journal.id}`,
        { cause: error },
      );
    }
    try {
      journal = await rollbackOnce();
      unregister();
      await finalizeTerminalJournal(options.context, roots, journal);
    } catch (rollbackError) {
      unregister();
      if (rollbackError instanceof ExecutionError) throw rollbackError;
      throw new ExecutionError(`Transaction failed and rollback requires recovery: ${journal.id}`, {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    if (error instanceof BlockedError) throw error;
    throw new ExecutionError(
      `Transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    unregister();
  }
}

export async function executeLocalTransaction(
  options: ExecuteLocalTransactionOptions,
): Promise<TransactionJournal> {
  if (options.members.length === 0) throw new Error("Local transaction has no members");
  if (new Set(options.members.map((member) => member.id)).size !== options.members.length)
    throw new Error("Local transaction member ids must be unique");
  return withTransactionMutationLock(options.context, () => executeLocked(options));
}
