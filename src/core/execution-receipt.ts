import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { BlockedError } from "../errors.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import {
  AdvisoryLockOperationAndReleaseError,
  AdvisoryLockReleaseError,
  withAdvisoryFileLock,
} from "./advisory-lock.ts";
import { syncDirectory } from "./local-transaction-paths.ts";
import type { ActionOperation, MigrationPlan } from "./migration-plan.ts";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.ts";
import { ensurePrivateStateDirectory } from "./transaction-journal.ts";

export type ExecutionReceiptOutcome =
  | "started"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "recovery_required"
  | "committed_with_failed_effects";

export interface ExecutionReceiptAction {
  readonly id: string;
  readonly operation: ActionOperation;
  readonly scope: "claude" | "codex" | "shared";
  readonly outcome: "pending" | "succeeded" | "skipped" | "failed";
  readonly durationMs?: number;
}

export interface ExecutionReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly toolVersion: string;
  readonly planId: string;
  readonly kind: "push" | "restore";
  readonly providers: readonly string[];
  readonly profile?: string;
  readonly targetRef: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly plannedPostFingerprint: string;
  readonly observedPostFingerprint?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly outcome: ExecutionReceiptOutcome;
  readonly actions: readonly ExecutionReceiptAction[];
  readonly warnings: readonly string[];
  readonly transactionId?: string;
  readonly transport: {
    readonly transferredBytes: number | null;
    readonly reusedBytes: number | null;
  };
}

export interface FinishExecutionReceiptInput {
  readonly outcome: Exclude<ExecutionReceiptOutcome, "started">;
  readonly finishedAt: Date;
  readonly actions?: readonly ExecutionReceiptAction[];
  readonly warnings?: readonly string[];
  readonly transactionId?: string;
  readonly observedPostFingerprint?: string;
  readonly transferredBytes?: number;
  readonly reusedBytes?: number;
}

export class ReceiptPublicationAmbiguousError extends Error {
  constructor(
    readonly receiptId: string,
    cause: unknown,
  ) {
    super(`Execution receipt publication needs reconciliation: ${receiptId}`, { cause });
    this.name = "ReceiptPublicationAmbiguousError";
  }
}

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 1024;
const RECEIPT_ID = /^rcpt_[a-f0-9]{32}$/;

export async function startExecutionReceipt(
  context: RuntimeContext,
  plan: MigrationPlan,
): Promise<ExecutionReceipt> {
  if (plan.kind !== "push" && plan.kind !== "restore")
    throw new Error("Only mutating plans can create execution receipts");
  const receipt: ExecutionReceipt = {
    schemaVersion: 1,
    id: `rcpt_${randomBytes(16).toString("hex")}`,
    revision: 0,
    toolVersion: packageMetadata.version,
    planId: plan.id,
    kind: plan.kind,
    providers: [...plan.providers],
    ...(plan.profile === undefined ? {} : { profile: plan.profile }),
    targetRef: plan.target.ref,
    sourceFingerprint: plan.sourceFingerprint,
    targetFingerprint: plan.targetFingerprint,
    plannedPostFingerprint: plan.stagedPostFingerprint,
    startedAt: context.now().toISOString(),
    outcome: "started",
    actions: plan.actions.map((action) => ({
      id: action.id,
      operation: action.operation,
      scope: action.scope,
      outcome:
        action.disposition === "unchanged" || action.disposition === "preserve"
          ? "skipped"
          : "pending",
    })),
    warnings: plan.warnings.map((warning) => warning.code),
    transport: { transferredBytes: null, reusedBytes: null },
  };
  await publishReceipt(context, receipt, null);
  return receipt;
}

export async function finishExecutionReceipt(
  context: RuntimeContext,
  started: ExecutionReceipt,
  input: FinishExecutionReceiptInput,
): Promise<ExecutionReceipt> {
  if (started.outcome !== "started") throw new Error("Execution receipt is already terminal");
  const durationMs = input.finishedAt.getTime() - new Date(started.startedAt).getTime();
  if (!Number.isSafeInteger(durationMs) || durationMs < 0)
    throw new Error("Execution receipt duration is invalid");
  const receipt: ExecutionReceipt = {
    ...started,
    revision: started.revision + 1,
    outcome: input.outcome,
    finishedAt: input.finishedAt.toISOString(),
    durationMs,
    actions:
      input.actions ??
      started.actions.map((action) => ({
        ...action,
        outcome:
          action.outcome === "pending"
            ? input.outcome === "succeeded"
              ? "succeeded"
              : "skipped"
            : action.outcome,
      })),
    warnings: [...new Set([...started.warnings, ...(input.warnings ?? [])])].sort(),
    ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
    ...(input.observedPostFingerprint === undefined
      ? {}
      : { observedPostFingerprint: input.observedPostFingerprint }),
    transport: {
      transferredBytes: input.transferredBytes ?? null,
      reusedBytes: input.reusedBytes ?? null,
    },
  };
  await publishReceipt(context, receipt, started.revision);
  return receipt;
}

export async function readExecutionReceipt(
  context: RuntimeContext,
  receiptId: string,
): Promise<ExecutionReceipt> {
  if (!RECEIPT_ID.test(receiptId)) throw new Error("Invalid execution receipt ID");
  const directory = await ensurePrivateStateDirectory(context, "receipts");
  const receipt = await readReceiptAt(join(directory, `${receiptId}.json`));
  if (receipt.id !== receiptId) throw new Error("Execution receipt filename identity mismatch");
  return receipt;
}

async function publishReceipt(
  context: RuntimeContext,
  receipt: ExecutionReceipt,
  expectedRevision: number | null,
): Promise<void> {
  const validated = validateReceipt(receipt);
  if (
    expectedRevision === null
      ? validated.revision !== 0
      : validated.revision !== expectedRevision + 1
  )
    throw new Error("Execution receipt revision does not match publication intent");
  const directory = await ensurePrivateStateDirectory(context, "receipts");
  const destination = join(directory, `${validated.id}.json`);
  let published = false;
  let directorySynced = false;
  try {
    await withReceiptWriterLock(join(directory, ".writer.lock"), async () => {
      if (expectedRevision === null) await pruneTerminalReceipts(directory);
      let existing: ExecutionReceipt | undefined;
      try {
        existing = await readReceiptAt(destination);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      if (
        expectedRevision === null ? existing !== undefined : existing?.revision !== expectedRevision
      )
        throw new Error("Execution receipt changed concurrently");
      if (existing) assertReceiptSuccessor(existing, validated);
      const encoded = `${JSON.stringify(validated)}\n`;
      const temporary = join(directory, `.${validated.id}.${randomBytes(8).toString("hex")}.tmp`);
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        if (existing) await rename(temporary, destination);
        else {
          await link(temporary, destination);
          published = true;
          await unlink(temporary);
        }
        published = true;
        await syncDirectory(directory);
        directorySynced = true;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  } catch (error) {
    const publicationError =
      error instanceof AdvisoryLockOperationAndReleaseError
        ? error.operationError
        : error instanceof AdvisoryLockReleaseError
          ? error
          : error;
    if (!published) throw error;
    if (!directorySynced)
      throw new ReceiptPublicationAmbiguousError(validated.id, publicationError);
    try {
      const current = await readReceiptAt(destination);
      if (JSON.stringify(current) === JSON.stringify(validated)) return;
    } catch (readError) {
      throw new ReceiptPublicationAmbiguousError(
        validated.id,
        new AggregateError([publicationError, readError]),
      );
    }
    throw new ReceiptPublicationAmbiguousError(validated.id, publicationError);
  }
}

async function withReceiptWriterLock<T>(path: string, callback: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withAdvisoryFileLock(path, callback);
    } catch (error) {
      if (!(error instanceof BlockedError) || attempt >= 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readReceiptAt(path: string): Promise<ExecutionReceipt> {
  const lexical = await lstat(path, { bigint: true });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !lexical.isFile() ||
      lexical.isSymbolicLink() ||
      !before.isFile() ||
      lexical.dev !== before.dev ||
      lexical.ino !== before.ino ||
      before.size > BigInt(MAX_RECEIPT_BYTES) ||
      (before.mode & 0o777n) !== 0o600n ||
      (process.getuid && before.uid !== BigInt(process.getuid()))
    )
      throw new Error("Unsafe execution receipt file");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.byteLength) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("Execution receipt changed while reading");
    return validateReceipt(parseJsonWithoutDuplicateKeys(bytes.toString("utf8")));
  } finally {
    await handle.close();
  }
}

async function pruneTerminalReceipts(directory: string): Promise<void> {
  const names = (await readdir(directory))
    .filter((name) => /^rcpt_[a-f0-9]{32}\.json$/.test(name))
    .sort();
  if (names.length < MAX_RECEIPTS) return;
  const terminal: Array<{ name: string; receipt: ExecutionReceipt }> = [];
  for (const name of names) {
    const receipt = await readReceiptAt(join(directory, name));
    if (receipt.id !== name.slice(0, -".json".length))
      throw new Error("Execution receipt filename identity mismatch");
    if (receipt.outcome !== "started") terminal.push({ name, receipt });
  }
  terminal.sort((left, right) =>
    left.receipt.startedAt === right.receipt.startedAt
      ? left.name.localeCompare(right.name)
      : left.receipt.startedAt.localeCompare(right.receipt.startedAt),
  );
  const removeCount = names.length - MAX_RECEIPTS + 1;
  if (terminal.length < removeCount)
    throw new Error("Execution receipt retention is full of active executions");
  for (const item of terminal.slice(0, removeCount)) await unlink(join(directory, item.name));
  await syncDirectory(directory);
}

function validateReceipt(value: unknown): ExecutionReceipt {
  const receipt = exactRecord(value, [
    "schemaVersion",
    "id",
    "revision",
    "toolVersion",
    "planId",
    "kind",
    "providers",
    "profile",
    "targetRef",
    "sourceFingerprint",
    "targetFingerprint",
    "plannedPostFingerprint",
    "observedPostFingerprint",
    "startedAt",
    "finishedAt",
    "durationMs",
    "outcome",
    "actions",
    "warnings",
    "transactionId",
    "transport",
  ]);
  const outcomes: readonly ExecutionReceiptOutcome[] = [
    "started",
    "succeeded",
    "failed",
    "rolled_back",
    "recovery_required",
    "committed_with_failed_effects",
  ];
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.id !== "string" ||
    !RECEIPT_ID.test(receipt.id) ||
    !nonnegativeInteger(receipt.revision) ||
    typeof receipt.toolVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(receipt.toolVersion) ||
    typeof receipt.planId !== "string" ||
    !/^plan_[a-f0-9]{64}$/.test(receipt.planId) ||
    (receipt.kind !== "push" && receipt.kind !== "restore") ||
    typeof receipt.targetRef !== "string" ||
    !/^endpoint_[a-f0-9]{32,64}$/.test(receipt.targetRef) ||
    typeof receipt.sourceFingerprint !== "string" ||
    !/^fp_[a-f0-9]{64}$/.test(receipt.sourceFingerprint) ||
    typeof receipt.targetFingerprint !== "string" ||
    !/^fp_[a-f0-9]{64}$/.test(receipt.targetFingerprint) ||
    typeof receipt.plannedPostFingerprint !== "string" ||
    !/^fp_[a-f0-9]{64}$/.test(receipt.plannedPostFingerprint) ||
    (receipt.observedPostFingerprint !== undefined &&
      (typeof receipt.observedPostFingerprint !== "string" ||
        !/^fp_[a-f0-9]{64}$/.test(receipt.observedPostFingerprint))) ||
    typeof receipt.startedAt !== "string" ||
    !validTimestamp(receipt.startedAt) ||
    typeof receipt.outcome !== "string" ||
    !outcomes.includes(receipt.outcome as ExecutionReceiptOutcome)
  )
    throw new Error("Execution receipt is invalid");
  if (
    !Array.isArray(receipt.providers) ||
    receipt.providers.length === 0 ||
    receipt.providers.some((provider) => provider !== "claude" && provider !== "codex") ||
    new Set(receipt.providers).size !== receipt.providers.length ||
    (receipt.profile !== undefined &&
      (typeof receipt.profile !== "string" ||
        !/^[a-z][a-z0-9._-]{0,127}$/.test(receipt.profile))) ||
    !Array.isArray(receipt.warnings) ||
    receipt.warnings.some(
      (warning) => typeof warning !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(warning),
    ) ||
    new Set(receipt.warnings).size !== receipt.warnings.length ||
    (receipt.transactionId !== undefined &&
      (typeof receipt.transactionId !== "string" ||
        !/^txn_[a-f0-9]{32}$/.test(receipt.transactionId)))
  )
    throw new Error("Execution receipt metadata is invalid");
  if (!Array.isArray(receipt.actions) || receipt.actions.length > 4096)
    throw new Error("Execution receipt actions are invalid");
  const actions = receipt.actions.map((value) => {
    const action = exactRecord(value, ["id", "operation", "scope", "outcome", "durationMs"]);
    if (
      typeof action.id !== "string" ||
      !/^action_[a-f0-9]{64}$/.test(action.id) ||
      (action.operation !== "archive" &&
        action.operation !== "overlay" &&
        action.operation !== "merge-json" &&
        action.operation !== "transform" &&
        action.operation !== "symlink" &&
        action.operation !== "external-effect") ||
      (action.scope !== "claude" && action.scope !== "codex" && action.scope !== "shared") ||
      (action.outcome !== "pending" &&
        action.outcome !== "succeeded" &&
        action.outcome !== "skipped" &&
        action.outcome !== "failed") ||
      (action.durationMs !== undefined && !nonnegativeInteger(action.durationMs))
    )
      throw new Error("Execution receipt action is invalid");
    return action as unknown as ExecutionReceiptAction;
  });
  if (new Set(actions.map((action) => action.id)).size !== actions.length)
    throw new Error("Execution receipt action IDs are not unique");
  const transport = exactRecord(receipt.transport, ["transferredBytes", "reusedBytes"]);
  if (
    (transport.transferredBytes !== null && !nonnegativeInteger(transport.transferredBytes)) ||
    (transport.reusedBytes !== null && !nonnegativeInteger(transport.reusedBytes))
  )
    throw new Error("Execution receipt transport metrics are invalid");
  const started = receipt.outcome === "started";
  if (
    started
      ? receipt.revision !== 0 ||
        receipt.finishedAt !== undefined ||
        receipt.durationMs !== undefined
      : receipt.revision !== 1 ||
        typeof receipt.finishedAt !== "string" ||
        !validTimestamp(receipt.finishedAt) ||
        !nonnegativeInteger(receipt.durationMs) ||
        receipt.finishedAt < receipt.startedAt ||
        receipt.durationMs !==
          new Date(receipt.finishedAt).getTime() -
            new Date(receipt.startedAt as string).getTime() ||
        actions.some(
          (action) =>
            action.durationMs !== undefined && action.durationMs > (receipt.durationMs as number),
        ) ||
        actions.some((action) => action.outcome === "pending")
  )
    throw new Error("Execution receipt lifecycle is invalid");
  if (
    started &&
    (actions.some((action) => action.outcome !== "pending" && action.outcome !== "skipped") ||
      actions.some((action) => action.durationMs !== undefined) ||
      receipt.observedPostFingerprint !== undefined ||
      transport.transferredBytes !== null ||
      transport.reusedBytes !== null)
  )
    throw new Error("Started execution receipt contains terminal data");
  if (
    receipt.outcome === "succeeded" &&
    (actions.some((action) => action.outcome !== "succeeded" && action.outcome !== "skipped") ||
      receipt.observedPostFingerprint !== receipt.plannedPostFingerprint)
  )
    throw new Error("Successful execution receipt contains failed actions");
  if (
    (receipt.outcome === "rolled_back" &&
      receipt.observedPostFingerprint !== receipt.targetFingerprint) ||
    (receipt.outcome === "committed_with_failed_effects" &&
      receipt.observedPostFingerprint !== receipt.plannedPostFingerprint)
  )
    throw new Error("Execution receipt outcome does not match its observed post-state");
  const validated = receipt as unknown as ExecutionReceipt;
  const encoded = JSON.stringify(validated);
  if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES)
    throw new Error("Execution receipt exceeds the size limit");
  return validated;
}

function assertReceiptSuccessor(existing: ExecutionReceipt, candidate: ExecutionReceipt): void {
  const immutable = (receipt: ExecutionReceipt) => ({
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    toolVersion: receipt.toolVersion,
    planId: receipt.planId,
    kind: receipt.kind,
    providers: receipt.providers,
    profile: receipt.profile,
    targetRef: receipt.targetRef,
    sourceFingerprint: receipt.sourceFingerprint,
    targetFingerprint: receipt.targetFingerprint,
    plannedPostFingerprint: receipt.plannedPostFingerprint,
    startedAt: receipt.startedAt,
    actions: receipt.actions.map(({ id, operation, scope }) => ({ id, operation, scope })),
  });
  if (
    existing.outcome !== "started" ||
    candidate.revision !== existing.revision + 1 ||
    existing.warnings.some((warning) => !candidate.warnings.includes(warning)) ||
    JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(candidate))
  )
    throw new Error("Execution receipt is not a valid successor");
  for (let index = 0; index < existing.actions.length; index += 1) {
    const before = existing.actions[index] as ExecutionReceiptAction;
    const after = candidate.actions[index] as ExecutionReceiptAction;
    if (
      (before.outcome === "skipped" && after.outcome !== "skipped") ||
      (candidate.outcome === "succeeded" &&
        before.outcome === "pending" &&
        after.outcome !== "succeeded")
    )
      throw new Error("Execution receipt action outcome is not a valid successor");
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Execution receipt value must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)))
    throw new Error("Execution receipt contains an unknown field");
  return record;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
