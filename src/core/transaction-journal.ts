import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BlockedError } from "../errors.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import {
  AdvisoryLockOperationAndReleaseError,
  AdvisoryLockReleaseError,
  withAdvisoryFileLock,
} from "./advisory-lock.ts";
import { validateCanonicalArchivePath } from "./archive-entries.ts";
import { ccmStateRoot, receiptDir, transactionJournalDir } from "./state-paths.ts";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.ts";

export type TransactionState =
  | "planning"
  | "preparing"
  | "prepared"
  | "committing"
  | "committed"
  | "aborting"
  | "rolling_back"
  | "rolled_back"
  | "recovery_required";

export type TransactionMemberState =
  | "pending"
  | "snapshotted"
  | "committed"
  | "rolled_back"
  | "untouched";

export type TransactionTargetKind = "absent" | "file" | "directory" | "symlink";

export interface TransactionMember {
  readonly id: string;
  readonly state: TransactionMemberState;
  readonly rootCode: string;
  readonly rootBinding?: string;
  readonly stageRef?: string;
  readonly rollbackRef?: string;
  readonly targetRef?: string;
  readonly originalKind?: TransactionTargetKind;
  readonly preimageFingerprint?: string;
  readonly postimageFingerprint?: string;
  readonly backupRef?: string;
}

export interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly id: string;
  readonly kind: "restore" | "push";
  readonly planId: string;
  readonly state: TransactionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly members: readonly TransactionMember[];
  readonly terminalErrorCode?: string;
}

export class JournalPublicationAmbiguousError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string, cause: unknown) {
    super(`Transaction journal publication needs reconciliation: ${transactionId}`, { cause });
    this.name = "JournalPublicationAmbiguousError";
    this.transactionId = transactionId;
  }
}

const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_MEMBERS = 256;
const MAX_JOURNALS = 1024;
const JOURNAL_ID = /^txn_[a-f0-9]{32}$/;
const SYMBOL = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLAN_ID = /^plan_[a-zA-Z0-9._-]{1,128}$/;
const FINGERPRINT = /^fp_[a-f0-9]{64}$/;
const ROOT_BINDING = /^root_[a-f0-9]{64}$/;
const BACKUP_REF = /^(0|[1-9][0-9]{0,19})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WRITER_LOCK = ".writer.lock";
const MUTATION_LOCK = ".mutation.lock";
const TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  planning: ["preparing", "rolling_back", "recovery_required"],
  preparing: ["prepared", "aborting", "rolling_back", "recovery_required"],
  prepared: ["committing", "aborting", "rolling_back", "recovery_required"],
  committing: ["committed", "rolling_back", "recovery_required"],
  committed: [],
  aborting: ["rolled_back", "recovery_required"],
  rolling_back: ["rolled_back", "recovery_required"],
  rolled_back: [],
  recovery_required: ["rolling_back", "committed", "rolled_back"],
};
const MEMBER_TRANSITIONS: Readonly<
  Record<TransactionMemberState, readonly TransactionMemberState[]>
> = {
  pending: ["pending", "snapshotted", "untouched"],
  snapshotted: ["snapshotted", "committed", "rolled_back"],
  committed: ["committed", "rolled_back"],
  rolled_back: ["rolled_back"],
  untouched: ["untouched"],
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains an unknown field`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function symbol(value: unknown, label: string): string {
  if (typeof value !== "string" || !SYMBOL.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function validateMemberShape(value: unknown, index: number): TransactionMember {
  const label = `journal member ${index}`;
  const member = record(value, label);
  exactKeys(
    member,
    [
      "id",
      "state",
      "rootCode",
      "rootBinding",
      "stageRef",
      "rollbackRef",
      "targetRef",
      "originalKind",
      "preimageFingerprint",
      "postimageFingerprint",
      "backupRef",
    ],
    label,
  );
  const state = member.state;
  if (
    state !== "pending" &&
    state !== "snapshotted" &&
    state !== "committed" &&
    state !== "rolled_back" &&
    state !== "untouched"
  )
    throw new Error(`${label} state is invalid`);
  const rootBinding = member.rootBinding;
  if (
    rootBinding !== undefined &&
    (typeof rootBinding !== "string" || !ROOT_BINDING.test(rootBinding))
  )
    throw new Error(`${label} rootBinding is invalid`);
  const stageRef =
    member.stageRef === undefined ? undefined : symbol(member.stageRef, `${label} stageRef`);
  const rollbackRef =
    member.rollbackRef === undefined
      ? undefined
      : symbol(member.rollbackRef, `${label} rollbackRef`);
  const targetRef =
    member.targetRef === undefined
      ? undefined
      : member.targetRef === "."
        ? "."
        : (() => {
            if (typeof member.targetRef !== "string" || member.targetRef.length > 512)
              throw new Error(`${label} targetRef is invalid`);
            try {
              validateCanonicalArchivePath(member.targetRef);
            } catch {
              throw new Error(`${label} targetRef is invalid`);
            }
            return member.targetRef;
          })();
  const originalKind = member.originalKind;
  if (
    originalKind !== undefined &&
    originalKind !== "absent" &&
    originalKind !== "file" &&
    originalKind !== "directory" &&
    originalKind !== "symlink"
  )
    throw new Error(`${label} originalKind is invalid`);
  const preimageFingerprint = member.preimageFingerprint;
  if (
    preimageFingerprint !== undefined &&
    (typeof preimageFingerprint !== "string" || !FINGERPRINT.test(preimageFingerprint))
  )
    throw new Error(`${label} preimageFingerprint is invalid`);
  const postimageFingerprint = member.postimageFingerprint;
  if (
    postimageFingerprint !== undefined &&
    (typeof postimageFingerprint !== "string" || !FINGERPRINT.test(postimageFingerprint))
  )
    throw new Error(`${label} postimageFingerprint is invalid`);
  const backupRef = member.backupRef;
  if (backupRef !== undefined && (typeof backupRef !== "string" || !BACKUP_REF.test(backupRef)))
    throw new Error(`${label} backupRef is invalid`);
  const recoveryFields = [
    targetRef,
    originalKind,
    preimageFingerprint,
    postimageFingerprint,
    backupRef,
  ];
  const recoveryFieldCount = recoveryFields.filter((field) => field !== undefined).length;
  if (recoveryFieldCount !== 0 && recoveryFieldCount !== recoveryFields.length)
    throw new Error(`${label} recovery metadata must be complete`);
  if (
    (state === "pending" || state === "untouched") &&
    (stageRef !== undefined || rollbackRef !== undefined)
  )
    throw new Error(`${label} ${state} state cannot have material references`);
  if (
    state !== "pending" &&
    state !== "untouched" &&
    (stageRef === undefined || rollbackRef === undefined)
  )
    throw new Error(`${label} ${state} state requires stage and rollback references`);
  return {
    id: symbol(member.id, `${label} id`),
    state,
    rootCode: symbol(member.rootCode, `${label} rootCode`),
    ...(rootBinding === undefined ? {} : { rootBinding }),
    ...(stageRef === undefined ? {} : { stageRef }),
    ...(rollbackRef === undefined ? {} : { rollbackRef }),
    ...(targetRef === undefined ? {} : { targetRef }),
    ...(originalKind === undefined ? {} : { originalKind }),
    ...(preimageFingerprint === undefined ? {} : { preimageFingerprint }),
    ...(postimageFingerprint === undefined ? {} : { postimageFingerprint }),
    ...(backupRef === undefined ? {} : { backupRef }),
  };
}

function validateGlobalInvariants(journal: TransactionJournal): void {
  const states = journal.members.map((member) => member.state);
  const all = (state: TransactionMemberState) => states.every((value) => value === state);
  if (journal.state === "planning" && !all("pending"))
    throw new Error("planning journal requires pending members");
  if (journal.state === "prepared" && !all("snapshotted"))
    throw new Error("prepared journal requires snapshotted members");
  if (journal.state === "committed" && !all("committed"))
    throw new Error("committed journal requires committed members");
  if (
    journal.state === "rolled_back" &&
    states.some((state) => state !== "rolled_back" && state !== "untouched")
  )
    throw new Error("rolled_back journal requires rolled_back or untouched members");
  if (
    journal.state === "committing" &&
    states.some((state) => state === "pending" || state === "rolled_back")
  )
    throw new Error("committing journal has invalid member state");
  if (
    (journal.state === "aborting" || journal.state === "rolling_back") &&
    states.some((state) => state === "pending")
  )
    throw new Error(`${journal.state} journal has unsnapshotted members`);
  if (journal.state === "recovery_required") {
    if (!journal.terminalErrorCode)
      throw new Error("recovery_required journal needs an error code");
  } else if (journal.terminalErrorCode !== undefined) {
    throw new Error("terminalErrorCode is only valid for recovery_required");
  }
  const targetsByRoot = new Map<string, string[]>();
  for (const member of journal.members) {
    if (member.targetRef === undefined) continue;
    const targets = targetsByRoot.get(member.rootCode) ?? [];
    targets.push(member.targetRef);
    targetsByRoot.set(member.rootCode, targets);
  }
  for (const targets of targetsByRoot.values()) {
    const portablePrefixes = new Map<string, string>();
    const portableTargets: string[] = [];
    for (const target of targets) {
      if (target === ".") {
        if (targets.length > 1) throw new Error("journal recovery targets overlap");
        portableTargets.push(target);
        continue;
      }
      const segments = target.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join("/");
        const portable = prefix.normalize("NFC").toLocaleLowerCase("en-US");
        const existing = portablePrefixes.get(portable);
        if (existing !== undefined && existing !== prefix)
          throw new Error("journal recovery targets have a portable collision");
        portablePrefixes.set(portable, prefix);
      }
      portableTargets.push(target.normalize("NFC").toLocaleLowerCase("en-US"));
    }
    portableTargets.sort();
    for (let index = 0; index < portableTargets.length; index += 1) {
      const target = portableTargets[index] as string;
      const next = portableTargets[index + 1];
      if (next !== undefined && (next === target || next.startsWith(`${target}/`)))
        throw new Error("journal recovery targets overlap");
    }
  }
}

export function parseTransactionJournal(source: string): TransactionJournal {
  if (Buffer.byteLength(source) > MAX_JOURNAL_BYTES)
    throw new Error("transaction journal exceeds the size limit");
  const root = record(parseJsonWithoutDuplicateKeys(source), "journal");
  exactKeys(
    root,
    [
      "schemaVersion",
      "revision",
      "id",
      "kind",
      "planId",
      "state",
      "createdAt",
      "updatedAt",
      "members",
      "terminalErrorCode",
    ],
    "journal",
  );
  if (root.schemaVersion !== 1) throw new Error("journal schemaVersion is unsupported");
  if (!Number.isSafeInteger(root.revision) || (root.revision as number) < 0)
    throw new Error("journal revision is invalid");
  if (typeof root.id !== "string" || !JOURNAL_ID.test(root.id))
    throw new Error("journal id is invalid");
  if (root.kind !== "restore" && root.kind !== "push") throw new Error("journal kind is invalid");
  if (typeof root.planId !== "string" || !PLAN_ID.test(root.planId))
    throw new Error("journal planId is invalid");
  if (typeof root.state !== "string" || !(root.state in TRANSITIONS))
    throw new Error("journal state is invalid");
  if (!Array.isArray(root.members) || root.members.length > MAX_MEMBERS)
    throw new Error("journal members are invalid");
  const members = root.members.map(validateMemberShape);
  if (new Set(members.map((member) => member.id)).size !== members.length)
    throw new Error("journal member ids must be unique");
  const createdAt = timestamp(root.createdAt, "journal createdAt");
  const updatedAt = timestamp(root.updatedAt, "journal updatedAt");
  if (updatedAt < createdAt) throw new Error("journal updatedAt precedes createdAt");
  const journal: TransactionJournal = {
    schemaVersion: 1,
    revision: root.revision as number,
    id: root.id,
    kind: root.kind,
    planId: root.planId,
    state: root.state as TransactionState,
    createdAt,
    updatedAt,
    members,
    ...(root.terminalErrorCode === undefined
      ? {}
      : { terminalErrorCode: symbol(root.terminalErrorCode, "journal terminalErrorCode") }),
  };
  validateGlobalInvariants(journal);
  return journal;
}

export function createTransactionJournal(input: {
  readonly kind: "restore" | "push";
  readonly planId: string;
  readonly now: Date;
  readonly members: readonly {
    readonly id: string;
    readonly rootCode: string;
    readonly rootBinding?: string;
  }[];
}): TransactionJournal {
  const at = input.now.toISOString();
  return parseTransactionJournal(
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      id: `txn_${randomBytes(16).toString("hex")}`,
      kind: input.kind,
      planId: input.planId,
      state: "planning",
      createdAt: at,
      updatedAt: at,
      members: input.members.map((member) => ({ ...member, state: "pending" })),
    }),
  );
}

export function transitionTransactionJournal(
  journal: TransactionJournal,
  state: TransactionState,
  now: Date,
  patch: {
    readonly members?: readonly TransactionMember[];
    readonly terminalErrorCode?: string | null;
  } = {},
): TransactionJournal {
  if (now.toISOString() <= journal.updatedAt)
    throw new Error("Transaction transition timestamp must increase");
  if (!TRANSITIONS[journal.state].includes(state))
    throw new Error(`Invalid transaction transition: ${journal.state} -> ${state}`);
  const members = patch.members ?? journal.members;
  if (members.length !== journal.members.length)
    throw new Error("Transaction members cannot change");
  for (let index = 0; index < members.length; index += 1) {
    const before = journal.members[index] as TransactionMember;
    const after = members[index] as TransactionMember;
    if (
      after.id !== before.id ||
      after.rootCode !== before.rootCode ||
      after.rootBinding !== before.rootBinding
    )
      throw new Error("Transaction member identity cannot change");
    if (!MEMBER_TRANSITIONS[before.state].includes(after.state))
      throw new Error(`Invalid transaction member transition: ${before.state} -> ${after.state}`);
    if (
      (before.stageRef !== undefined && after.stageRef !== before.stageRef) ||
      (before.rollbackRef !== undefined && after.rollbackRef !== before.rollbackRef)
    )
      throw new Error("Transaction member material references cannot change");
    if (
      (before.targetRef !== undefined && after.targetRef !== before.targetRef) ||
      (before.originalKind !== undefined && after.originalKind !== before.originalKind) ||
      (before.preimageFingerprint !== undefined &&
        after.preimageFingerprint !== before.preimageFingerprint) ||
      (before.postimageFingerprint !== undefined &&
        after.postimageFingerprint !== before.postimageFingerprint) ||
      (before.backupRef !== undefined && after.backupRef !== before.backupRef)
    )
      throw new Error("Transaction member recovery metadata cannot change");
  }
  return parseTransactionJournal(
    JSON.stringify({
      ...journal,
      revision: journal.revision + 1,
      state,
      updatedAt: now.toISOString(),
      members,
      ...(patch.terminalErrorCode === null
        ? { terminalErrorCode: undefined }
        : patch.terminalErrorCode
          ? { terminalErrorCode: patch.terminalErrorCode }
          : {}),
    }),
  );
}

function assertJournalSuccessor(existing: TransactionJournal, candidate: TransactionJournal): void {
  if (
    candidate.id !== existing.id ||
    candidate.kind !== existing.kind ||
    candidate.planId !== existing.planId ||
    candidate.createdAt !== existing.createdAt ||
    candidate.revision !== existing.revision + 1 ||
    candidate.updatedAt <= existing.updatedAt ||
    !TRANSITIONS[existing.state].includes(candidate.state) ||
    candidate.members.length !== existing.members.length
  )
    throw new BlockedError("Transaction journal is not a valid successor");
  for (let index = 0; index < existing.members.length; index += 1) {
    const before = existing.members[index] as TransactionMember;
    const after = candidate.members[index] as TransactionMember;
    if (
      after.id !== before.id ||
      after.rootCode !== before.rootCode ||
      after.rootBinding !== before.rootBinding ||
      !MEMBER_TRANSITIONS[before.state].includes(after.state) ||
      (before.stageRef !== undefined && after.stageRef !== before.stageRef) ||
      (before.rollbackRef !== undefined && after.rollbackRef !== before.rollbackRef)
    )
      throw new BlockedError("Transaction journal member is not a valid successor");
    if (
      (before.targetRef !== undefined && after.targetRef !== before.targetRef) ||
      (before.originalKind !== undefined && after.originalKind !== before.originalKind) ||
      (before.preimageFingerprint !== undefined &&
        after.preimageFingerprint !== before.preimageFingerprint) ||
      (before.postimageFingerprint !== undefined &&
        after.postimageFingerprint !== before.postimageFingerprint) ||
      (before.backupRef !== undefined && after.backupRef !== before.backupRef)
    )
      throw new BlockedError("Transaction journal member recovery metadata changed");
  }
}

async function syncDirectory(path: string): Promise<void> {
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

async function assertPrivateDirectory(path: string): Promise<void> {
  const lexical = resolve(path);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe CCM state directory");
  if (process.getuid && info.uid !== process.getuid())
    throw new Error("Unowned CCM state directory");
  if ((info.mode & 0o077) !== 0) throw new Error("CCM state directory is not private");
  if ((await realpath(lexical)) !== lexical)
    throw new Error("CCM state directory is not canonical");
}

async function ensurePrivateLeaf(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertPrivateDirectory(path);
  if (created) await syncDirectory(dirname(path));
}

async function ensureCanonicalStateHome(path: string): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let existing = target;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      missing.push(existing);
      const parent = dirname(existing);
      if (parent === existing) throw new Error("Cannot establish XDG state directory");
      existing = parent;
    }
  }
  const anchor = await lstat(existing);
  const currentUid = process.getuid?.();
  const writable = (anchor.mode & 0o022) !== 0;
  const sticky = (anchor.mode & 0o1000) !== 0;
  if (
    !anchor.isDirectory() ||
    anchor.isSymbolicLink() ||
    (await realpath(existing)) !== existing ||
    (currentUid !== undefined && anchor.uid !== 0 && anchor.uid !== currentUid) ||
    (writable && !sticky)
  )
    throw new Error("Unsafe XDG state directory ancestry");
  for (const directory of missing.reverse()) {
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    if (created) await syncDirectory(dirname(directory));
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (currentUid !== undefined && info.uid !== currentUid) ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Unsafe XDG state directory");
  }
  const chain: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  for (const directory of chain.reverse()) {
    const info = await lstat(directory);
    const isWritable = (info.mode & 0o022) !== 0;
    const isStickyAncestor = directory !== target && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (currentUid !== undefined && info.uid !== 0 && info.uid !== currentUid) ||
      (isWritable && !isStickyAncestor) ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Unsafe XDG state directory ancestry");
  }
}

export async function ensurePrivateStateDirectory(
  context: RuntimeContext,
  kind: "transactions" | "receipts",
): Promise<string> {
  const root = ccmStateRoot(context);
  const stateHome = dirname(root);
  await ensureCanonicalStateHome(stateHome);
  const stateInfo = await lstat(stateHome);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink())
    throw new Error("Unsafe XDG state directory");
  if (process.getuid && stateInfo.uid !== process.getuid())
    throw new Error("Unowned XDG state directory");
  if ((stateInfo.mode & 0o022) !== 0) throw new Error("Writable XDG state directory is unsafe");
  if ((await realpath(stateHome)) !== resolve(stateHome))
    throw new Error("XDG state directory is not canonical");
  await ensurePrivateLeaf(root);
  const directory = kind === "transactions" ? transactionJournalDir(context) : receiptDir(context);
  await ensurePrivateLeaf(directory);
  return directory;
}

async function ensureJournalDirectory(context: RuntimeContext): Promise<string> {
  return ensurePrivateStateDirectory(context, "transactions");
}

async function readHandleBounded(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_JOURNAL_BYTES || (before.mode & 0o177) !== 0)
      throw new Error("Unsafe transaction journal file");
    if (process.getuid && before.uid !== process.getuid())
      throw new Error("Unowned transaction journal file");
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_JOURNAL_BYTES) throw new Error("transaction journal exceeds the size limit");
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      offset !== after.size
    )
      throw new Error("Transaction journal changed while reading");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readJournalAt(directory: string, name: string): Promise<TransactionJournal> {
  if (!/^txn_[a-f0-9]{32}\.json$/.test(name))
    throw new Error("Invalid transaction journal filename");
  const journal = parseTransactionJournal(await readHandleBounded(join(directory, name)));
  if (`${journal.id}.json` !== name) throw new Error("Transaction journal identity mismatch");
  return journal;
}

async function withWriterLock<T>(
  directory: string,
  transactionId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = join(directory, WRITER_LOCK);
  try {
    return await withAdvisoryFileLock(lock, async () => {
      await syncDirectory(directory);
      return callback();
    });
  } catch (error) {
    if (
      error instanceof AdvisoryLockReleaseError ||
      (error instanceof AdvisoryLockOperationAndReleaseError &&
        error.operationError instanceof JournalPublicationAmbiguousError)
    )
      throw new JournalPublicationAmbiguousError(transactionId, error);
    throw error;
  }
}

async function countJournalFiles(directory: string): Promise<number> {
  let count = 0;
  const entries = await readdir(directory);
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    count += 1;
    if (count >= MAX_JOURNALS) return count;
  }
  return count;
}

export async function publishTransactionJournal(
  context: RuntimeContext,
  journal: TransactionJournal,
  expectedRevision: number | null,
): Promise<string> {
  const validated = parseTransactionJournal(JSON.stringify(journal));
  const encoded = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES)
    throw new Error("transaction journal exceeds the size limit");
  if (
    expectedRevision === null
      ? validated.revision !== 0
      : validated.revision !== expectedRevision + 1
  )
    throw new Error("Journal revision does not match publication intent");
  const directory = await ensureJournalDirectory(context);
  return withWriterLock(directory, validated.id, async () => {
    if (expectedRevision === null && (await countJournalFiles(directory)) >= MAX_JOURNALS)
      throw new BlockedError("Transaction journal retention limit reached");
    const name = `${validated.id}.json`;
    const destination = join(directory, name);
    let existing: TransactionJournal | undefined;
    try {
      existing = await readJournalAt(directory, name);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (
      expectedRevision === null ? existing !== undefined : existing?.revision !== expectedRevision
    )
      throw new BlockedError("Transaction journal changed concurrently");
    if (existing) assertJournalSuccessor(existing, validated);
    const temporary = join(directory, `.${validated.id}.${randomBytes(8).toString("hex")}.tmp`);
    let published = false;
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      published = true;
      try {
        await syncDirectory(directory);
      } catch (error) {
        throw new JournalPublicationAmbiguousError(validated.id, error);
      }
      return destination;
    } catch (error) {
      await handle.close().catch(() => {});
      if (!published) await unlink(temporary).catch(() => {});
      throw error;
    }
  });
}

export async function deleteTerminalTransactionJournal(
  context: RuntimeContext,
  transactionId: string,
  expectedRevision: number,
): Promise<void> {
  if (!JOURNAL_ID.test(transactionId)) throw new Error("Invalid transaction id");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("Invalid expected journal revision");
  const directory = await ensureJournalDirectory(context);
  await withWriterLock(directory, transactionId, async () => {
    const journal = await readJournalAt(directory, `${transactionId}.json`);
    if (journal.revision !== expectedRevision)
      throw new BlockedError("Transaction journal changed concurrently");
    if (isIncompleteTransaction(journal))
      throw new BlockedError("Incomplete transaction journals cannot be deleted");
    await unlink(join(directory, `${transactionId}.json`));
    try {
      await syncDirectory(directory);
    } catch (error) {
      throw new JournalPublicationAmbiguousError(transactionId, error);
    }
  });
}

export async function readTransactionJournal(
  context: RuntimeContext,
  transactionId: string,
): Promise<TransactionJournal> {
  if (!JOURNAL_ID.test(transactionId)) throw new Error("Invalid transaction id");
  const directory = await ensureJournalDirectory(context);
  return readJournalAt(directory, `${transactionId}.json`);
}

export async function listTransactionJournals(
  context: RuntimeContext,
): Promise<readonly TransactionJournal[]> {
  const directory = await ensureJournalDirectory(context);
  await assertPrivateDirectory(directory);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_JOURNALS) throw new Error("Too many transaction journals");
  const journals: TransactionJournal[] = [];
  for (const name of names) {
    try {
      journals.push(await readJournalAt(directory, name));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return journals;
}

export function isIncompleteTransaction(journal: TransactionJournal): boolean {
  return journal.state !== "committed" && journal.state !== "rolled_back";
}

export async function withTransactionMutationLock<T>(
  context: RuntimeContext,
  callback: () => Promise<T>,
): Promise<T> {
  const directory = await ensureJournalDirectory(context);
  return withAdvisoryFileLock(join(directory, MUTATION_LOCK), callback);
}
