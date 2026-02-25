import { join } from "node:path";
import type { FileEntry } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { mergeMcpServers } from "./mcp.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runRemote(host: string, command: string, quiet = false) {
  let proc = Bun.$`ssh ${host} ${command}`;

  if (quiet) {
    proc = proc.quiet();
  }

  return proc;
}

async function remotePathExists(host: string, path: string): Promise<boolean> {
  const result = await runRemote(host, `test -e ${shellQuote(path)} && echo yes || echo no`, true);

  return result.stdout.toString().trim() === "yes";
}

async function remoteDirectoryExists(host: string, path: string): Promise<boolean> {
  const result = await runRemote(host, `test -d ${shellQuote(path)} && echo yes || echo no`, true);

  return result.stdout.toString().trim() === "yes";
}

async function syncDirectory(host: string, sourceDir: string, targetDir: string): Promise<void> {
  await runRemote(host, `mkdir -p ${shellQuote(targetDir)}`);
  await runRemote(host, `cp -r ${shellQuote(sourceDir)}/. ${shellQuote(targetDir)}/`);
}

async function backupDirectoryIfExists(host: string, dirPath: string): Promise<void> {
  const backupDir = `${dirPath}.backup-${Date.now()}`;
  const command = `if [ -d ${shellQuote(dirPath)} ]; then cp -r ${shellQuote(dirPath)} ${shellQuote(backupDir)}; fi`;
  await runRemote(host, command, true).nothrow();
}

async function mergeClaudeMcpConfig(
  host: string,
  incomingPath: string,
  remoteMcpPath: string,
): Promise<void> {
  const incomingResult = await runRemote(host, `cat ${shellQuote(incomingPath)}`, true);
  const existingResult = await runRemote(
    host,
    `if [ -f ${shellQuote(remoteMcpPath)} ]; then cat ${shellQuote(remoteMcpPath)}; else echo '{}'; fi`,
    true,
  );

  const mergedJson = mergeMcpServers(
    existingResult.stdout.toString(),
    incomingResult.stdout.toString(),
  );

  const b64 = Buffer.from(mergedJson).toString("base64");
  await runRemote(host, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remoteMcpPath)}`);

  const incoming = JSON.parse(incomingResult.stdout.toString()) as {
    mcpServers?: Record<string, unknown>;
  };
  const serverCount = Object.keys(incoming.mcpServers ?? {}).length;
  log.dim(`  Merged ${serverCount} MCP server(s) into ${remoteMcpPath}`);

  await runRemote(host, `rm -f ${shellQuote(incomingPath)}`);
}

async function recreateClaudeSharedSkillSymlinks(
  host: string,
  remoteClaudeDir: string,
  remoteAgentsDir: string,
): Promise<void> {
  const claudeSkillsDir = join(remoteClaudeDir, "skills");
  const agentsSkillsDir = join(remoteAgentsDir, "skills");

  const command = [
    `mkdir -p ${shellQuote(claudeSkillsDir)}`,
    `if [ -d ${shellQuote(agentsSkillsDir)} ]; then`,
    `for skill in ${shellQuote(agentsSkillsDir)}/*; do`,
    `[ -d "$skill" ] || continue`,
    'name=$(basename "$skill")',
    `ln -sfn ${shellQuote(agentsSkillsDir)}/"$name" ${shellQuote(claudeSkillsDir)}/"$name"`,
    "done",
    "fi",
  ].join("; ");

  await runRemote(host, command);
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
    const result = await Bun.$`ssh ${host} 'echo $HOME'`.quiet();
    const home = result.stdout.toString().trim();
    return home || "~";
  } catch {
    return "~";
  }
}

export async function pushArchive(archivePath: string, host: string): Promise<boolean> {
  const remoteHome = await getRemoteHome(host);

  const remoteClaudeDir = join(remoteHome, ".claude");
  const remoteCodexDir = join(remoteHome, ".codex");
  const remoteAgentsDir = join(remoteHome, ".agents");
  const remoteMcpPath = join(remoteHome, ".claude.json");

  const remoteTempArchive = `/tmp/ccm-archive-${Date.now()}.tar.gz`;
  const remoteTempDir = `/tmp/ccm-extract-${Date.now()}`;

  try {
    log.info(`Uploading archive to ${host}...`);
    await Bun.$`scp ${archivePath} ${host}:${remoteTempArchive}`;

    log.info("Extracting on remote...");
    await runRemote(
      host,
      `mkdir -p ${shellQuote(remoteTempDir)} && tar -xzf ${shellQuote(remoteTempArchive)} -C ${shellQuote(remoteTempDir)}`,
    );

    const remoteClaudeExtract = join(remoteTempDir, "claude");
    const remoteCodexExtract = join(remoteTempDir, "codex");
    const remoteSharedExtract = join(remoteTempDir, "shared", "agents");

    const hasClaude = await remoteDirectoryExists(host, remoteClaudeExtract);
    const hasCodex = await remoteDirectoryExists(host, remoteCodexExtract);
    const hasShared = await remoteDirectoryExists(host, remoteSharedExtract);

    if (hasClaude) {
      log.info("Syncing Claude provider...");
      await backupDirectoryIfExists(host, remoteClaudeDir);

      const incomingMcpPath = join(remoteClaudeExtract, ".mcp-config.json");
      if (await remotePathExists(host, incomingMcpPath)) {
        await mergeClaudeMcpConfig(host, incomingMcpPath, remoteMcpPath);
      }

      await syncDirectory(host, remoteClaudeExtract, remoteClaudeDir);
    }

    if (hasCodex) {
      log.info("Syncing Codex provider...");
      await backupDirectoryIfExists(host, remoteCodexDir);
      await syncDirectory(host, remoteCodexExtract, remoteCodexDir);
    }

    if (hasShared) {
      log.info("Syncing shared skills...");
      await syncDirectory(host, remoteSharedExtract, remoteAgentsDir);
    }

    if (hasClaude && hasShared) {
      log.info("Recreating Claude shared skill symlinks...");
      await recreateClaudeSharedSkillSymlinks(host, remoteClaudeDir, remoteAgentsDir);
    }

    log.success(`Successfully pushed config to ${host}`);
    return true;
  } catch (error) {
    log.error(`Push failed: ${error}`);
    return false;
  } finally {
    await runRemote(
      host,
      `rm -rf ${shellQuote(remoteTempArchive)} ${shellQuote(remoteTempDir)}`,
      true,
    ).nothrow();
  }
}

export async function previewPush(files: FileEntry[], host: string): Promise<void> {
  log.info(`Would push to ${host}`);
  log.info(`Files to transfer (${files.length}):`);

  for (const file of files) {
    const symlinkNote = file.isSymlink ? ` (symlink -> ${file.originalSymlinkTarget})` : "";
    const displayPath =
      file.relativePath === "claude/.mcp-config.json" ? "~/.claude.json (MCP)" : file.relativePath;
    log.file(displayPath, symlinkNote);
  }
}
