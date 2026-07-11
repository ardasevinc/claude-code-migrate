import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRestoreProvider } from "../core/arg-parser.ts";
import { restoreArchive } from "../core/restore.ts";
import { CliError } from "../errors.ts";
import type { ProviderName, RestoreOptions } from "../types/index.ts";

export async function restoreCommand(
  archiveArg: string,
  providerArg: string | undefined,
  options: RestoreOptions,
): Promise<void> {
  const archivePath = resolve(archiveArg);

  if (!(await exists(archivePath))) {
    throw new CliError(`Archive not found: ${archivePath}`);
  }

  let provider: ProviderName | undefined;

  try {
    provider = resolveRestoreProvider(providerArg);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Invalid provider");
  }

  await restoreArchive(archivePath, provider, { dryRun: options.dryRun });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
