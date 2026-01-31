import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { log } from "../utils/logger.ts";
import type { FileEntry } from "../types/index.ts";

function expandPath(path: string, remoteHome?: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", remoteHome ?? homedir());
  }
  return path;
}

export async function testConnection(host: string): Promise<boolean> {
  try {
    const result = await Bun.$`ssh -o BatchMode=yes -o ConnectTimeout=5 ${host} "echo ok"`.quiet();
    return result.stdout.toString().trim() === "ok";
  } catch {
    return false;
  }
}

export async function getRemoteHome(host: string): Promise<string> {
  try {
    const result = await Bun.$`ssh ${host} "echo $HOME"`.quiet();
    return result.stdout.toString().trim();
  } catch {
    return "~";
  }
}

export async function pushArchive(
  archivePath: string,
  host: string,
  remotePath: string
): Promise<boolean> {
  const remoteHome = await getRemoteHome(host);
  const expandedPath = expandPath(remotePath, remoteHome);
  const remoteClaudeDir = expandedPath;
  const remoteMcpPath = join(dirname(expandedPath), ".claude.json");

  const remoteTempArchive = `/tmp/ccm-archive-${Date.now()}.tar.gz`;
  const remoteTempDir = `/tmp/ccm-extract-${Date.now()}`;

  try {
    log.info(`Uploading archive to ${host}...`);
    await Bun.$`scp ${archivePath} ${host}:${remoteTempArchive}`;

    log.info("Extracting on remote...");
    await Bun.$`ssh ${host} "mkdir -p ${remoteTempDir} && tar -xzf ${remoteTempArchive} -C ${remoteTempDir}"`;

    log.info("Creating backup of existing config...");
    const backupDir = `${remoteClaudeDir}.backup-${Date.now()}`;
    await Bun.$`ssh ${host} "if [ -d ${remoteClaudeDir} ]; then cp -r ${remoteClaudeDir} ${backupDir}; fi"`.quiet().nothrow();

    log.info("Syncing files...");
    await Bun.$`ssh ${host} "mkdir -p ${remoteClaudeDir}"`;

    // Handle MCP config separately - it goes to ~/.claude.json, not inside ~/.claude/
    const hasMcpConfig = await Bun.$`ssh ${host} "test -f ${remoteTempDir}/.mcp-config.json && echo yes || echo no"`.quiet();
    if (hasMcpConfig.stdout.toString().trim() === "yes") {
      await Bun.$`ssh ${host} "mv ${remoteTempDir}/.mcp-config.json ${remoteMcpPath}"`;
      log.dim(`  Copied MCP config to ${remoteMcpPath}`);
    }

    // Remove manifest before bulk copy
    await Bun.$`ssh ${host} "rm -f ${remoteTempDir}/.ccm-manifest.json"`;

    // Bulk copy everything else - this replaces N SSH calls with 1
    await Bun.$`ssh ${host} "cp -r ${remoteTempDir}/. ${remoteClaudeDir}/"`;

    log.info("Cleaning up...");
    await Bun.$`ssh ${host} "rm -rf ${remoteTempArchive} ${remoteTempDir}"`.quiet();

    log.success(`Successfully pushed config to ${host}:${remotePath}`);
    return true;
  } catch (error) {
    log.error(`Push failed: ${error}`);
    return false;
  }
}

export async function previewPush(
  files: FileEntry[],
  host: string,
  remotePath: string
): Promise<void> {
  log.info(`Would push to ${host}:${remotePath}`);
  log.info(`Files to transfer (${files.length}):`);

  for (const file of files) {
    const symlinkNote = file.isSymlink
      ? ` (symlink -> ${file.originalSymlinkTarget})`
      : "";
    const displayPath =
      file.relativePath === ".mcp-config.json" ? "~/.claude.json (MCP)" : file.relativePath;
    log.file(displayPath, symlinkNote);
  }
}
