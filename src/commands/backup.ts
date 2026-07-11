import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { createArchive } from "../core/archiver.ts";
import { getEnabledProviders, resolveBackupArguments } from "../core/arg-parser.ts";
import { collectFiles } from "../core/collector.ts";
import { CliError } from "../errors.ts";
import type { BackupOptions } from "../types/index.ts";
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
  const config = await loadConfig();
  const enabledProviders = getEnabledProviders(config);

  let providers = enabledProviders;
  let outputArg: string | undefined;

  try {
    const resolved = resolveBackupArguments(arg1, arg2, enabledProviders);
    providers = resolved.providers;
    outputArg = resolved.output;
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Invalid arguments");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFilename = `ccm-backup-${timestamp}.tar.gz`;

  let outputPath: string;

  if (outputArg) {
    outputPath = expandPath(outputArg);
    if (!outputPath.endsWith(".tar.gz")) {
      outputPath = join(outputPath, defaultFilename);
    }
  } else {
    const backupDir = expandPath(config.backup.path);
    outputPath = join(backupDir, defaultFilename);
  }

  const files = await collectFiles({
    providers,
    includeClaudeSettingsLocal: config.providers.claude.settings_local,
    includeClaudeMcpConfig: config.providers.claude.mcp_config,
    dryRun: options.dryRun,
  });

  if (files.length === 0) {
    throw new CliError("No files to backup");
  }

  if (options.dryRun) {
    log.info(`Would create backup at: ${outputPath}`);
    log.info(`Files to include (${files.length}):`);

    for (const file of files) {
      const symlinkNote = file.isSymlink ? ` (symlink -> ${file.originalSymlinkTarget})` : "";
      const displayPath =
        file.relativePath === "claude/.mcp-config.json"
          ? "~/.claude.json (MCP)"
          : file.relativePath;
      log.file(displayPath, symlinkNote);
    }

    return;
  }

  await createArchive(files, outputPath);
  log.info(`Backup contains ${files.length} files`);
}
