import { isAbsolute, join } from "node:path";
import type { RuntimeContext } from "../runtime/context.ts";

export function ccmStateRoot(context: RuntimeContext): string {
  const configured = context.process.env.XDG_STATE_HOME;
  const stateHome =
    configured && isAbsolute(configured) ? configured : join(context.home, ".local/state");
  return join(stateHome, "ccm");
}

export function transactionJournalDir(context: RuntimeContext): string {
  return join(ccmStateRoot(context), "transactions");
}

export function receiptDir(context: RuntimeContext): string {
  return join(ccmStateRoot(context), "receipts");
}
