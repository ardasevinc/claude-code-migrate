import { join, relative } from "node:path";
import { readlink, lstat, realpath, readdir } from "node:fs/promises";
import {
  CLAUDE_DIR,
  MCP_CONFIG_PATH,
  ALWAYS_INCLUDE,
  INCLUDE_IF_EXISTS,
  NEVER_MIGRATE,
} from "../config/schema.ts";
import type { FileEntry, CollectorOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { extractMcpServers } from "./mcp.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function collectDirectory(
  dirPath: string,
  basePath: string,
  entries: FileEntry[],
  virtualPrefix?: string
): Promise<void> {
  const dirEntries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of dirEntries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = virtualPrefix
      ? join(virtualPrefix, entry.name)
      : relative(basePath, fullPath);

    if (entry.isSymbolicLink()) {
      const target = await readlink(fullPath);
      const realPath = await realpath(fullPath).catch(() => null);

      if (!realPath || !(await exists(realPath))) continue;

      const realStat = await lstat(realPath);

      if (realStat.isDirectory()) {
        await collectDirectory(realPath, realPath, entries, relativePath);
      } else {
        entries.push({
          sourcePath: realPath,
          relativePath,
          isSymlink: true,
          originalSymlinkTarget: target,
        });
      }
    } else if (entry.isDirectory()) {
      await collectDirectory(fullPath, basePath, entries, virtualPrefix ? relativePath : undefined);
    } else {
      entries.push({
        sourcePath: fullPath,
        relativePath,
        isSymlink: false,
      });
    }
  }
}

async function collectFile(
  filePath: string,
  basePath: string,
  entries: FileEntry[]
): Promise<void> {
  if (!(await exists(filePath))) return;

  const relativePath = relative(basePath, filePath);

  if (await isSymlink(filePath)) {
    const target = await readlink(filePath);
    const realPath = await realpath(filePath).catch(() => null);

    if (realPath && (await exists(realPath))) {
      entries.push({
        sourcePath: realPath,
        relativePath,
        isSymlink: true,
        originalSymlinkTarget: target,
      });
    }
  } else {
    entries.push({
      sourcePath: filePath,
      relativePath,
      isSymlink: false,
    });
  }
}

export async function collectFiles(options: CollectorOptions): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  if (!(await exists(CLAUDE_DIR))) {
    log.error(`Claude directory not found: ${CLAUDE_DIR}`);
    return entries;
  }

  for (const item of ALWAYS_INCLUDE) {
    const fullPath = join(CLAUDE_DIR, item);

    if (!(await exists(fullPath))) {
      if (!options.dryRun) {
        log.warn(`Missing required: ${item}`);
      }
      continue;
    }

    // Check if it's a symlink pointing to a directory
    const isSymlinkToDir =
      (await isSymlink(fullPath)) &&
      (await realpath(fullPath)
        .then(async (p) => {
          const stat = await lstat(p);
          return stat.isDirectory();
        })
        .catch(() => false));

    if ((await isDirectory(fullPath)) || isSymlinkToDir) {
      const actualPath = isSymlinkToDir ? await realpath(fullPath) : fullPath;
      await collectDirectory(actualPath, CLAUDE_DIR, entries, item);
    } else {
      await collectFile(fullPath, CLAUDE_DIR, entries);
    }
  }

  for (const item of INCLUDE_IF_EXISTS) {
    const fullPath = join(CLAUDE_DIR, item);

    if (!(await exists(fullPath))) continue;

    // Check if it's a symlink pointing to a directory
    const isSymlinkToDir =
      (await isSymlink(fullPath)) &&
      (await realpath(fullPath)
        .then(async (p) => {
          const stat = await lstat(p);
          return stat.isDirectory();
        })
        .catch(() => false));

    if ((await isDirectory(fullPath)) || isSymlinkToDir) {
      const actualPath = isSymlinkToDir ? await realpath(fullPath) : fullPath;
      await collectDirectory(actualPath, CLAUDE_DIR, entries, item);
    } else {
      await collectFile(fullPath, CLAUDE_DIR, entries);
    }
  }

  if (options.includeSettingsLocal) {
    const settingsLocal = join(CLAUDE_DIR, "settings.local.json");
    if (await exists(settingsLocal)) {
      await collectFile(settingsLocal, CLAUDE_DIR, entries);
    }
  }

  if (options.includeMcpConfig && (await exists(MCP_CONFIG_PATH))) {
    const { mcpServers, warnings } = await extractMcpServers(MCP_CONFIG_PATH);

    if (warnings.length > 0) {
      log.warn("MCP servers with paths that may not work on remote:");
      for (const w of warnings) log.dim(`  ${w}`);
    }

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      entries.push({
        sourcePath: MCP_CONFIG_PATH,
        relativePath: ".mcp-config.json",
        isSymlink: false,
        mcpServersOnly: JSON.stringify({ mcpServers }, null, 2),
      });
    }
  }

  const filtered = entries.filter((entry) => {
    const firstSegment = entry.relativePath.split("/")[0];
    return !NEVER_MIGRATE.includes(firstSegment as typeof NEVER_MIGRATE[number]);
  });

  return filtered;
}
