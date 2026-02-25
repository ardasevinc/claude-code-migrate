import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRestoreProvider } from "../core/arg-parser.ts";
import { restoreArchive } from "../core/restore.ts";
import type { ProviderName, RestoreOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";

export async function restoreCommand(
  archiveArg: string,
  providerArg: string | undefined,
  options: RestoreOptions,
): Promise<void> {
  const archivePath = resolve(archiveArg);

  if (!(await exists(archivePath))) {
    log.error(`Archive not found: ${archivePath}`);
    return;
  }

  let provider: ProviderName | undefined;

  try {
    provider = resolveRestoreProvider(providerArg);
  } catch (error) {
    log.error(error instanceof Error ? error.message : "Invalid provider");
    return;
  }

  const success = await restoreArchive(archivePath, provider, { dryRun: options.dryRun });
  if (!success) {
    process.exit(1);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
