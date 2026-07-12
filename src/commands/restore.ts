import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { collectionPathsForHome } from "../config/providers.ts";
import { resolveRestoreProvider } from "../core/arg-parser.ts";
import {
  executePlannedRestore,
  planRestore,
  type PlannedRestore,
  RestoreTargetPlanError,
  RestoreTransformPlanError,
} from "../core/plan-restore.ts";
import { BlockedError, UsageError } from "../errors.ts";
import { createRuntimeContext, type RuntimeContext } from "../runtime/context.ts";
import type { ProviderName, RestoreOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";

export async function restoreCommand(
  archiveArg: string,
  providerArg: string | undefined,
  options: RestoreOptions,
): Promise<void> {
  return restoreCommandWithContext(archiveArg, providerArg, options, createRuntimeContext());
}

export async function restoreCommandWithContext(
  archiveArg: string,
  providerArg: string | undefined,
  options: RestoreOptions,
  context: RuntimeContext,
): Promise<void> {
  if (options.json && !options.dryRun) throw new UsageError("--json currently requires --dry-run");
  const archivePath = resolve(archiveArg);

  if (!(await exists(archivePath))) {
    throw new BlockedError(`Archive not found: ${archivePath}`);
  }

  let provider: ProviderName | undefined;

  try {
    provider = resolveRestoreProvider(providerArg);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid provider", {
      cause: error,
    });
  }

  let planned: PlannedRestore;
  try {
    planned = await planRestore({
      archivePath,
      provider,
      context,
      paths: collectionPathsForHome(context.home),
    });
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    if (error instanceof RestoreTargetPlanError || error instanceof RestoreTransformPlanError)
      throw new BlockedError(error.message, { cause: error });
    throw new BlockedError("Archive is invalid or unreadable", { cause: error });
  }
  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify(planned.plan));
      return;
    }
    log.info(`Restore plan ${planned.plan.id} (${planned.plan.status})`);
    log.info(`Providers: ${planned.plan.providers.join(", ")}`);
    if (options.verbose)
      for (const action of planned.plan.actions)
        log.dim(`  ${action.phase}: ${action.operation} ${action.scope} (${action.disposition})`);
    return;
  }
  await executePlannedRestore(planned);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
