import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config/loader.ts";
import { collectFiles } from "../core/collector.ts";
import { createArchive } from "../core/archiver.ts";
import { log } from "../utils/logger.ts";
import type { BackupOptions } from "../types/index.ts";

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  return resolve(path);
}

export async function backupCommand(
  outputArg: string | undefined,
  options: BackupOptions
): Promise<void> {
  const config = await loadConfig();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFilename = `claude-config-${timestamp}.tar.gz`;

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
    includeSettingsLocal: config.include.settings_local,
    includeMcpConfig: config.include.mcp_config,
    dryRun: options.dryRun,
  });

  if (files.length === 0) {
    log.error("No files to backup");
    return;
  }

  if (options.dryRun) {
    log.info(`Would create backup at: ${outputPath}`);
    log.info(`Files to include (${files.length}):`);

    for (const file of files) {
      const symlinkNote = file.isSymlink
        ? ` (symlink -> ${file.originalSymlinkTarget})`
        : "";
      const displayPath =
        file.relativePath === ".mcp-config.json" ? "~/.claude.json (MCP)" : file.relativePath;
      log.file(displayPath, symlinkNote);
    }
    return;
  }

  await createArchive(files, outputPath);
  log.info(`Backup contains ${files.length} files`);
}
