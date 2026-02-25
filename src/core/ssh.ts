import { join } from "node:path";
import type { FileEntry } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
import { mergeMcpServers } from "./mcp.ts";

async function runRemote(
  host: string,
  command: string,
  options: { quiet?: boolean; nothrow?: boolean } = {},
) {
  return runCommand(`ssh ${shellQuote(host)} ${shellQuote(command)}`, options);
}

export function parseRemoteHome(rawStdout: string): string {
  const home = rawStdout.trim();
  if (!home || home === "~") {
    throw new Error("Could not resolve remote $HOME");
  }

  if (!home.startsWith("/")) {
    throw new Error(`Unexpected remote $HOME value: ${home}`);
  }

  return home;
}

export function buildClaudeSharedSkillSymlinkCommand(
  claudeSkillsDir: string,
  agentsSkillsDir: string,
): string {
  const cs = shellQuote(claudeSkillsDir);
  const as_ = shellQuote(agentsSkillsDir);
  return `mkdir -p ${cs}; if [ -d ${as_} ]; then for skill in ${as_}/*; do [ -d "$skill" ] || continue; name=$(basename "$skill"); target=${cs}/"$name"; rm -rf "$target"; ln -s ${as_}/"$name" "$target"; done; fi`;
}

async function remotePathExists(host: string, path: string): Promise<boolean> {
  const result = await runRemote(host, `test -e ${shellQuote(path)} && echo yes || echo no`, {
    quiet: true,
  });

  return result.stdout.trim() === "yes";
}

async function remoteDirectoryExists(host: string, path: string): Promise<boolean> {
  const result = await runRemote(host, `test -d ${shellQuote(path)} && echo yes || echo no`, {
    quiet: true,
  });

  return result.stdout.trim() === "yes";
}

async function syncDirectory(host: string, sourceDir: string, targetDir: string): Promise<void> {
  await runRemote(host, `mkdir -p ${shellQuote(targetDir)}`);
  await runRemote(host, `cp -r ${shellQuote(sourceDir)}/. ${shellQuote(targetDir)}/`);
}

async function backupDirectoryIfExists(host: string, dirPath: string): Promise<void> {
  const backupDir = `${dirPath}.backup-${Date.now()}`;
  const command = `if [ -d ${shellQuote(dirPath)} ]; then cp -r ${shellQuote(dirPath)} ${shellQuote(backupDir)}; fi`;
  await runRemote(host, command, { quiet: true, nothrow: true });
}

async function mergeClaudeMcpConfig(
  host: string,
  incomingPath: string,
  remoteMcpPath: string,
): Promise<void> {
  const incomingResult = await runRemote(host, `cat ${shellQuote(incomingPath)}`, { quiet: true });
  const existingResult = await runRemote(
    host,
    `if [ -f ${shellQuote(remoteMcpPath)} ]; then cat ${shellQuote(remoteMcpPath)}; else echo '{}'; fi`,
    { quiet: true },
  );

  const mergedJson = mergeMcpServers(existingResult.stdout, incomingResult.stdout);

  const b64 = Buffer.from(mergedJson).toString("base64");
  await runRemote(host, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remoteMcpPath)}`);

  const incoming = JSON.parse(incomingResult.stdout) as {
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
  const command = buildClaudeSharedSkillSymlinkCommand(claudeSkillsDir, agentsSkillsDir);

  await runRemote(host, command);
}

export async function testConnection(host: string): Promise<boolean> {
  const result = await runCommand(
    `ssh -o BatchMode=yes -o ConnectTimeout=5 ${shellQuote(host)} "echo ok"`,
    {
      quiet: true,
      nothrow: true,
    },
  );

  return result.exitCode === 0 && result.stdout.trim() === "ok";
}

export async function getRemoteHome(host: string): Promise<string> {
  const result = await runCommand(`ssh ${shellQuote(host)} 'echo $HOME'`, { quiet: true });
  return parseRemoteHome(result.stdout);
}

export async function pushArchive(archivePath: string, host: string): Promise<boolean> {
  const remoteTempArchive = `/tmp/ccm-archive-${Date.now()}.tar.gz`;
  const remoteTempDir = `/tmp/ccm-extract-${Date.now()}`;

  try {
    const remoteHome = await getRemoteHome(host);
    const remoteClaudeDir = join(remoteHome, ".claude");
    const remoteCodexDir = join(remoteHome, ".codex");
    const remoteAgentsDir = join(remoteHome, ".agents");
    const remoteMcpPath = join(remoteHome, ".claude.json");

    log.info(`Uploading archive to ${host}...`);
    const remoteSpec = `${host}:${remoteTempArchive}`;
    await runCommand(`scp ${shellQuote(archivePath)} ${shellQuote(remoteSpec)}`);

    log.info("Extracting on remote...");
    await runRemote(
      host,
      `mkdir -p ${shellQuote(remoteTempDir)} && tar -xzf ${shellQuote(remoteTempArchive)} -C ${shellQuote(remoteTempDir)} 2>/dev/null`,
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
      await backupDirectoryIfExists(host, remoteAgentsDir);
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
    await runRemote(host, `rm -rf ${shellQuote(remoteTempArchive)} ${shellQuote(remoteTempDir)}`, {
      quiet: true,
      nothrow: true,
    });
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
