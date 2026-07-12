import { recoverLocalTransaction } from "../core/local-transaction.ts";
import { listTransactionJournals, type TransactionJournal } from "../core/transaction-journal.ts";
import { UsageError } from "../errors.ts";
import { createRuntimeContext, type RuntimeContext } from "../runtime/context.ts";

interface TransactionsOptions {
  readonly json?: boolean;
}

interface RecoverOptions {
  readonly rollback?: boolean;
  readonly accept?: boolean;
  readonly json?: boolean;
}

export async function transactionsCommand(options: TransactionsOptions): Promise<void> {
  return transactionsCommandWithContext(options, createRuntimeContext());
}

export async function recoverCommand(
  transactionId: string,
  options: RecoverOptions,
): Promise<void> {
  return recoverCommandWithContext(transactionId, options, createRuntimeContext());
}

export async function recoverCommandWithContext(
  transactionId: string,
  options: RecoverOptions,
  context: RuntimeContext,
): Promise<void> {
  if (!/^txn_[a-f0-9]{32}$/.test(transactionId))
    throw new UsageError("Transaction ID must be a canonical txn_<hex> identifier");
  if (Boolean(options.rollback) === Boolean(options.accept))
    throw new UsageError("Choose exactly one recovery mode: --rollback or --accept");
  const mode = options.rollback ? "rollback" : "accept";
  const journal = await recoverLocalTransaction({ context, transactionId, mode });
  const result = { transactionId: journal.id, outcome: journal.state, mode };
  if (options.json) console.log(JSON.stringify(result));
  else console.log(`Transaction ${journal.id} ${journal.state}.`);
}

export async function transactionsCommandWithContext(
  options: TransactionsOptions,
  context: RuntimeContext,
): Promise<void> {
  const journals = await listTransactionJournals(context);
  const projected = journals.map(projectTransaction);
  if (options.json) {
    console.log(JSON.stringify({ transactions: projected }));
    return;
  }
  if (projected.length === 0) {
    console.log("No CCM transactions.");
    return;
  }
  for (const transaction of projected) {
    console.log(`${transaction.id}  ${transaction.state}  ${transaction.kind}`);
    console.log(`  plan: ${transaction.planId}`);
    console.log(`  updated: ${transaction.updatedAt}`);
    console.log(`  members: ${transaction.members.length}`);
    if (transaction.terminalErrorCode) console.log(`  recovery: ${transaction.terminalErrorCode}`);
  }
}

function projectTransaction(journal: TransactionJournal) {
  return {
    id: journal.id,
    kind: journal.kind,
    planId: journal.planId,
    state: journal.state,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    members: journal.members.map((member) => ({
      id: member.id,
      rootCode: member.rootCode,
      state: member.state,
      ...(member.targetRef === undefined ? {} : { targetRef: member.targetRef }),
      ...(member.originalKind === undefined ? {} : { originalKind: member.originalKind }),
      ...(member.backupRef === undefined ? {} : { backupRef: member.backupRef }),
    })),
    ...(journal.terminalErrorCode === undefined
      ? {}
      : { terminalErrorCode: journal.terminalErrorCode }),
  };
}
