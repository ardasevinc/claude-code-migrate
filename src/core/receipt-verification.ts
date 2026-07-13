import { collectionPathsForHome } from "../config/providers.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import { type ExecutionReceipt, executionReceiptEndpointRef } from "./execution-receipt.ts";
import {
  claudeMcpManagedEntry,
  managedStateVerificationFingerprint,
} from "./managed-state-verification.ts";
import { observeRemotePushTarget, type PushObservationTransport } from "./push-observation.ts";
import { observeLocalManagedInventory } from "./restore-observation.ts";
import { createSshSession, type SshSession } from "./ssh-session.ts";

export interface ReceiptVerificationResult {
  readonly schemaVersion: 1;
  readonly kind: "receipt-verification";
  readonly receiptId: string;
  readonly outcome: ExecutionReceipt["outcome"];
  readonly valid: boolean;
  readonly status: "verified" | "drifted" | "unavailable";
  readonly reasonCode:
    | "managed-state-matches"
    | "managed-state-drifted"
    | "legacy-receipt"
    | "execution-not-terminal"
    | "terminal-state-unobserved"
    | "plugin-state-unobserved"
    | "remote-target-required"
    | "target-mismatch";
  readonly expectedFingerprint?: string;
  readonly observedFingerprint?: string;
}

interface ReceiptVerificationDependencies {
  readonly createSession: (host: string) => Promise<SshSession>;
}

const defaultDependencies: ReceiptVerificationDependencies = { createSession: createSshSession };

class PluginStateUnavailableError extends Error {}

export async function verifyExecutionReceipt(
  context: RuntimeContext,
  receipt: ExecutionReceipt,
  options: { readonly remoteTarget?: string } = {},
  dependencies: ReceiptVerificationDependencies = defaultDependencies,
): Promise<ReceiptVerificationResult> {
  const base = {
    schemaVersion: 1 as const,
    kind: "receipt-verification" as const,
    receiptId: receipt.id,
    outcome: receipt.outcome,
  };
  const scope = receipt.verification;
  if (!scope) return { ...base, valid: false, status: "unavailable", reasonCode: "legacy-receipt" };
  if (receipt.outcome === "started")
    return {
      ...base,
      valid: false,
      status: "unavailable",
      reasonCode: "execution-not-terminal",
    };
  if (!scope.observedFingerprint)
    return {
      ...base,
      valid: false,
      status: "unavailable",
      reasonCode: "terminal-state-unobserved",
    };

  let observedFingerprint: string;
  if (scope.mode === "local") {
    if (
      options.remoteTarget !== undefined ||
      executionReceiptEndpointRef("local", context.home) !== scope.endpointRef
    )
      return { ...base, valid: false, status: "unavailable", reasonCode: "target-mismatch" };
    observedFingerprint = managedStateVerificationFingerprint(
      await observeLocalManagedInventory({
        context,
        paths: collectionPathsForHome(context.home),
        inventoryRoots: scope.inventoryRoots,
      }),
    );
  } else {
    if (!options.remoteTarget)
      return {
        ...base,
        valid: false,
        status: "unavailable",
        reasonCode: "remote-target-required",
      };
    if (executionReceiptEndpointRef("remote", options.remoteTarget) !== scope.endpointRef)
      return { ...base, valid: false, status: "unavailable", reasonCode: "target-mismatch" };
    try {
      observedFingerprint = await observeRemoteInventory(
        options.remoteTarget,
        scope.inventoryRoots,
        scope.claudeMcp,
        scope.codexPluginList,
        dependencies.createSession,
      );
    } catch (error) {
      if (error instanceof PluginStateUnavailableError)
        return {
          ...base,
          valid: false,
          status: "unavailable",
          reasonCode: "plugin-state-unobserved",
        };
      throw error;
    }
  }
  const valid = observedFingerprint === scope.observedFingerprint;
  return {
    ...base,
    valid,
    status: valid ? "verified" : "drifted",
    reasonCode: valid ? "managed-state-matches" : "managed-state-drifted",
    expectedFingerprint: scope.observedFingerprint,
    observedFingerprint,
  };
}

async function observeRemoteInventory(
  host: string,
  inventoryRoots: readonly string[],
  claudeMcp: boolean,
  codexPluginList: boolean,
  createSession: ReceiptVerificationDependencies["createSession"],
): Promise<string> {
  let session: SshSession | undefined;
  let primaryError: unknown;
  let observed: string | undefined;
  try {
    session = await createSession(host);
    const transport: PushObservationTransport = {
      run: async (requestedHost, command, options) => {
        if (requestedHost !== host) throw new Error("Receipt verification target changed");
        if (!session) throw new Error("Receipt verification SSH session is unavailable");
        return session.run(command, {
          nothrow: true,
          maxBuffer: options.maxBuffer,
          timeoutMs: options.timeout,
        });
      },
    };
    const result = await observeRemotePushTarget({
      host,
      incoming: [],
      inventoryRoots: inventoryRoots.filter((root) => root !== "claude/.mcp-config.json"),
      queries: {
        captureIds: claudeMcp ? ["claude-mcp"] : [],
        codexPluginList,
      },
      transport,
    });
    const mcp = claudeMcp ? result.facts.captures.get("claude-mcp") : undefined;
    if (codexPluginList && result.facts.codexPluginList.status !== "ok")
      throw new PluginStateUnavailableError("Managed Codex plugin state could not be observed");
    observed = managedStateVerificationFingerprint(
      [...result.inventory, ...(claudeMcp ? [claudeMcpManagedEntry(mcp ?? undefined)] : [])],
      codexPluginList && result.facts.codexPluginList.status === "ok"
        ? result.facts.codexPluginList
        : undefined,
    );
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await session?.close();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [primaryError, cleanupError],
      "Receipt verification and SSH cleanup failed",
    );
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return observed as string;
}
