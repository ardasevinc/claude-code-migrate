import { loadConfig } from "../config/loader.ts";
import {
  type ExecutionReceipt,
  executionReceiptEndpointRef,
  listExecutionReceipts,
  readExecutionReceipt,
} from "../core/execution-receipt.ts";
import {
  type ReceiptVerificationResult,
  verifyExecutionReceipt,
} from "../core/receipt-verification.ts";
import {
  BlockedError,
  type CcmExitCode,
  CliError,
  ReportedCliError,
  UsageError,
} from "../errors.ts";
import { createRuntimeContext, type RuntimeContext } from "../runtime/context.ts";

interface ReceiptCommandOptions {
  readonly json?: boolean;
  readonly remote?: string;
  readonly files?: boolean;
}

export async function receiptsCommand(options: Pick<ReceiptCommandOptions, "json">): Promise<void> {
  const receipts = await listExecutionReceipts(createRuntimeContext());
  const projected = receipts.map((receipt) => ({
    id: receipt.id,
    migrationKind: receipt.kind,
    providers: receipt.providers,
    ...(receipt.profile === undefined ? {} : { profile: receipt.profile }),
    outcome: receipt.outcome,
    startedAt: receipt.startedAt,
    ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
  }));
  if (options.json) {
    console.log(JSON.stringify({ receipts: projected }));
    return;
  }
  if (projected.length === 0) {
    console.log("No CCM receipts.");
    return;
  }
  for (const receipt of projected) {
    console.log(
      `${receipt.id}  ${receipt.outcome}  ${receipt.migrationKind}  ${receipt.providers.join(",")}`,
    );
    console.log(`  started: ${receipt.startedAt}`);
    if (receipt.profile) console.log(`  profile: ${receipt.profile}`);
  }
}

export async function inspectReceiptCommand(
  receiptId: string,
  options: Pick<ReceiptCommandOptions, "json" | "files">,
): Promise<void> {
  await reportReceiptErrors("inspect", options, async () => {
    if (options.files) throw new CliError("--files is available only for archive inspection", 2);
    const context = createRuntimeContext();
    const receipt = await readReceipt(context, await resolveReceiptId(context, receiptId));
    const output = projectReceipt(receipt);
    if (options.json) console.log(JSON.stringify(output));
    else printReceipt(output);
  });
}

export async function verifyReceiptCommand(
  receiptId: string,
  options: ReceiptCommandOptions,
): Promise<void> {
  await reportReceiptErrors("verify", options, async () => {
    const context = createRuntimeContext();
    const receipt = await readReceipt(context, await resolveReceiptId(context, receiptId));
    const remoteTarget = options.remote ?? (await inferRemoteTarget(receipt));
    const output = await verifyExecutionReceipt(context, receipt, {
      remoteTarget,
    });
    if (options.json) console.log(JSON.stringify(output));
    else printVerification(output);
    if (!output.valid) throw new ReportedCliError(1);
  });
}

async function resolveReceiptId(context: RuntimeContext, requested: string): Promise<string> {
  if (requested !== "latest") return requested;
  const latest = (await listExecutionReceipts(context))[0];
  if (!latest) throw new BlockedError("No execution receipts are available");
  return latest.id;
}

async function inferRemoteTarget(receipt: ExecutionReceipt): Promise<string | undefined> {
  if (receipt.verification?.mode !== "remote") return undefined;
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig();
  } catch {
    return undefined;
  }
  const candidates = [config.target.host, ...Object.values(config.profiles).map(({ host }) => host)]
    .filter((host) => host !== "user@example.com")
    .filter((host, index, hosts) => hosts.indexOf(host) === index)
    .filter(
      (host) => executionReceiptEndpointRef("remote", host) === receipt.verification?.endpointRef,
    );
  if (candidates.length > 1) {
    throw new UsageError("Multiple configured targets match this receipt; use --remote");
  }
  return candidates[0];
}

async function readReceipt(
  context: ReturnType<typeof createRuntimeContext>,
  receiptId: string,
): Promise<ExecutionReceipt> {
  try {
    return await readExecutionReceipt(context, receiptId);
  } catch (error) {
    throw new BlockedError("Execution receipt is unavailable or invalid", { cause: error });
  }
}

export function projectReceipt(receipt: ExecutionReceipt): Record<string, unknown> {
  const verification = receipt.verification;
  const verificationProjection =
    verification === undefined
      ? { available: false, reasonCode: "legacy-receipt" }
      : receipt.outcome === "started"
        ? { available: false, reasonCode: "execution-not-terminal" }
        : verification.observedFingerprint === undefined
          ? { available: false, reasonCode: "terminal-state-unobserved" }
          : {
              available: true,
              mode: verification.mode,
              endpointRef: verification.endpointRef,
              inventoryRoots: verification.inventoryRoots,
              claudeMcp: verification.claudeMcp,
              codexPluginList: verification.codexPluginList,
              beforeFingerprint: verification.beforeFingerprint,
              plannedFingerprint: verification.plannedFingerprint,
              observedFingerprint: verification.observedFingerprint,
            };
  return {
    schemaVersion: 1,
    kind: "execution-receipt",
    receipt: {
      schemaVersion: receipt.schemaVersion,
      id: receipt.id,
      revision: receipt.revision,
      toolVersion: receipt.toolVersion,
      planId: receipt.planId,
      migrationKind: receipt.kind,
      providers: receipt.providers,
      ...(receipt.profile === undefined ? {} : { profile: receipt.profile }),
      targetRef: receipt.targetRef,
      sourceFingerprint: receipt.sourceFingerprint,
      targetFingerprint: receipt.targetFingerprint,
      plannedPostFingerprint: receipt.plannedPostFingerprint,
      ...(receipt.filesystemPostFingerprint === undefined
        ? {}
        : { filesystemPostFingerprint: receipt.filesystemPostFingerprint }),
      ...(receipt.observedPostFingerprint === undefined
        ? {}
        : { observedPostFingerprint: receipt.observedPostFingerprint }),
      startedAt: receipt.startedAt,
      ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
      ...(receipt.durationMs === undefined ? {} : { durationMs: receipt.durationMs }),
      outcome: receipt.outcome,
      actions: receipt.actions,
      warnings: receipt.warnings,
      ...(receipt.transactionId === undefined ? {} : { transactionId: receipt.transactionId }),
      transport: receipt.transport,
      verification: verificationProjection,
    },
  };
}

function printReceipt(output: ReturnType<typeof projectReceipt>): void {
  const receipt = output.receipt as Record<string, unknown>;
  console.log(`Receipt: ${receipt.id}`);
  console.log(`Migration: ${receipt.migrationKind}`);
  console.log(`Outcome: ${receipt.outcome}`);
  console.log(`Plan: ${receipt.planId}`);
  const verification = receipt.verification as {
    available: boolean;
    mode?: string;
    reasonCode?: string;
  };
  console.log(
    verification.available
      ? `Drift verification: available (${verification.mode})`
      : `Drift verification: unavailable (${verification.reasonCode})`,
  );
}

function printVerification(output: ReceiptVerificationResult): void {
  if (output.status === "verified") {
    console.log("Managed state matches the receipt's observed terminal state.");
    return;
  }
  if (output.status === "drifted") {
    console.log("Managed state has drifted from the receipt's observed terminal state.");
    return;
  }
  console.log(`Receipt verification unavailable (${output.reasonCode}).`);
}

async function reportReceiptErrors(
  operation: "inspect" | "verify",
  options: Pick<ReceiptCommandOptions, "json">,
  callback: () => Promise<void>,
): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (!options.json || error instanceof ReportedCliError) throw error;
    const exitCode: CcmExitCode = error instanceof CliError ? error.exitCode : 5;
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        kind: "receipt-error",
        operation,
        error: { code: errorCode(exitCode), exitCode },
      }),
    );
    throw new ReportedCliError(exitCode, { cause: error });
  }
}

function errorCode(exitCode: CcmExitCode): string {
  return (
    {
      1: "failed",
      2: "invalid-request",
      3: "blocked",
      4: "unreachable",
      5: "execution-failed",
    } as const
  )[exitCode];
}
