import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { log } from "../utils/logger.ts";
import { shellQuote } from "../utils/shell.ts";

export const DEFAULT_BACKUP_RETENTION = 5;

function getBackupPrefix(dirPath: string): string {
  return `${basename(dirPath)}.backup-`;
}

function isBackupNameForDir(name: string, dirPath: string): boolean {
  const prefix = getBackupPrefix(dirPath);
  if (!name.startsWith(prefix)) {
    return false;
  }

  return /^\d+$/.test(name.slice(prefix.length));
}

function backupSequence(name: string, dirPath: string): bigint {
  return BigInt(name.slice(getBackupPrefix(dirPath).length));
}

export async function pruneLocalBackups(
  dirPath: string,
  keep = DEFAULT_BACKUP_RETENTION,
): Promise<void> {
  const parentDir = dirname(dirPath);
  const entries = await readdir(parentDir, { withFileTypes: true });
  const backupNames = entries
    .filter(
      (entry) => (entry.isDirectory() || entry.isFile()) && isBackupNameForDir(entry.name, dirPath),
    )
    .map((entry) => entry.name)
    .sort((a, b) => {
      const left = backupSequence(a, dirPath);
      const right = backupSequence(b, dirPath);
      return left === right ? 0 : left > right ? -1 : 1;
    });

  const staleBackups = backupNames.slice(keep);

  for (const backupName of staleBackups) {
    const backupPath = join(parentDir, backupName);
    try {
      await rm(backupPath, { recursive: true, force: true });
      log.dim(`  Pruned old backup ${backupPath}`);
    } catch (error) {
      log.warn(`Failed to prune old backup ${backupPath}: ${error}`);
    }
  }
}

export async function pruneLocalBackupsIfParentExists(
  dirPath: string,
  keep = DEFAULT_BACKUP_RETENTION,
): Promise<void> {
  try {
    await lstat(dirname(dirPath));
  } catch {
    return;
  }

  await pruneLocalBackups(dirPath, keep);
}

export function buildRemoteBackupPruneCommand(
  dirPath: string,
  keep = DEFAULT_BACKUP_RETENTION,
): string {
  const dir = shellQuote(dirPath);
  const keepArg = shellQuote(String(keep));
  return `parent=$(dirname ${dir}); base=$(basename ${dir}); find "$parent" -maxdepth 1 -type d -name "$base.backup-[0-9]*" | sort -r | awk -v keep=${keepArg} 'NR > keep { print }' | while IFS= read -r old; do rm -rf "$old" || echo "failed to prune $old" >&2; done`;
}
