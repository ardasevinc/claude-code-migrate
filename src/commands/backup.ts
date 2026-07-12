import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { getEnabledProviders, resolveBackupArguments } from "../core/arg-parser.ts";
import { collectFiles } from "../core/collector.ts";
import { executePlannedBackup, planBackup } from "../core/plan-backup.ts";
import { BlockedError, UsageError } from "../errors.ts";
import type { BackupOptions, FileEntry } from "../types/index.ts";
import { log } from "../utils/logger.ts";

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }

  return resolve(path);
}

export async function backupCommand(
  arg1: string | undefined,
  arg2: string | undefined,
  options: BackupOptions,
): Promise<void> {
  if (options.json && !options.dryRun) {
    throw new UsageError("--json currently requires --dry-run");
  }
  const config = await loadConfig();
  const enabledProviders = getEnabledProviders(config);

  let providers = enabledProviders;
  let outputArg: string | undefined;

  try {
    const resolved = resolveBackupArguments(arg1, arg2, enabledProviders);
    providers = resolved.providers;
    outputArg = resolved.output;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid arguments", {
      cause: error,
    });
  }

  const operationDate = new Date();
  const timestamp = operationDate.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFilename = `ccm-backup-${timestamp}.tar.gz`;

  let outputPath: string;
  let outputIdentity: string;

  if (outputArg) {
    outputPath = expandPath(outputArg);
    outputIdentity = outputPath;
    if (!outputPath.endsWith(".tar.gz")) {
      outputPath = join(outputPath, defaultFilename);
    }
  } else {
    const backupDir = expandPath(config.backup.path);
    outputIdentity = backupDir;
    outputPath = join(backupDir, defaultFilename);
  }

  const files: FileEntry[] = await collectFiles({
    providers,
    includeClaudeSettingsLocal: config.providers.claude.settings_local,
    includeClaudeMcpConfig: config.providers.claude.mcp_config,
    dryRun: options.dryRun,
    quiet: options.json,
  });

  if (files.length === 0) {
    throw new BlockedError("No files to backup");
  }

  const planned = await planBackup({
    files,
    outputPath,
    providers,
    force: options.force,
    createdAt: operationDate.toISOString(),
    outputSource: outputArg === undefined ? "default" : "explicit",
    outputIdentity,
  });

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify(planned.plan));
      return;
    }
    log.info(`Backup plan ${planned.plan.id} (${planned.plan.status})`);
    log.info(`Files to include: ${files.length}`);

    if (options.verbose)
      for (const file of files) {
        const displayPath =
          file.relativePath === "claude/.mcp-config.json"
            ? "~/.claude.json (MCP)"
            : file.relativePath;
        log.file(displayPath);
      }

    return;
  }

  await executePlannedBackup(planned);
  log.info(`Backup contains ${files.length} files`);
}
