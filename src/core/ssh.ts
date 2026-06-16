import { join } from "node:path";
import type { FileEntry } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
import { buildRemoteBackupPruneCommand } from "./backup-retention.ts";
import {
  adaptCodexConfigForHost,
  codexMarketplaceArchivePath,
  rewriteCodexMarketplaceSources,
} from "./codex.ts";
import { mergeMcpServers, normalizeCodexMcpCommandPaths } from "./mcp.ts";

export type PushAction = "claude" | "codex" | "shared" | "claude-shared-symlinks";

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

export function buildRemoteCommandPathResolutionCommand(
  binaryName: string,
  remoteHome: string,
): string {
  const binary = shellQuote(binaryName);
  const candidatePaths = [
    join(remoteHome, ".bun", "bin", binaryName),
    join(remoteHome, ".local", "bin", binaryName),
    join(remoteHome, "bin", binaryName),
    join("/usr/local/bin", binaryName),
    join("/usr/bin", binaryName),
  ]
    .map(shellQuote)
    .join(" ");

  return `resolved=$(command -v ${binary} 2>/dev/null) && { printf '%s\\n' "$resolved"; exit 0; }; for candidate in ${candidatePaths}; do if [ -x "$candidate" ]; then printf '%s\\n' "$candidate"; exit 0; fi; done; exit 1`;
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
  const dir = shellQuote(dirPath);
  const pruneCommand = buildRemoteBackupPruneCommand(dirPath);
  const command = `if [ -d ${dir} ]; then backup=${dir}.backup-$(date +%s%3N); cp -r ${dir} "$backup" && { ${pruneCommand}; }; fi`;
  const result = await runRemote(host, command, { quiet: true, nothrow: true });

  if (result.exitCode !== 0) {
    log.warn(`Failed to back up or prune ${dirPath} on ${host}: ${result.stderr || result.stdout}`);
  }
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

async function normalizeRemoteCodexMcpCommands(
  host: string,
  remoteCodexConfigPath: string,
  remoteHome: string,
): Promise<void> {
  const existingResult = await runRemote(
    host,
    `if [ -f ${shellQuote(remoteCodexConfigPath)} ]; then cat ${shellQuote(remoteCodexConfigPath)}; fi`,
    { quiet: true },
  );

  if (!existingResult.stdout.trim()) {
    return;
  }

  const normalized = await normalizeCodexMcpCommandPaths(
    existingResult.stdout,
    async (binaryName) => {
      const result = await runRemote(
        host,
        buildRemoteCommandPathResolutionCommand(binaryName, remoteHome),
        {
          quiet: true,
          nothrow: true,
        },
      );

      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },
  );

  for (const warning of normalized.warnings) {
    log.warn(`[codex] MCP command normalization skipped: ${warning}`);
  }

  if (normalized.changes.length === 0) {
    return;
  }

  const b64 = Buffer.from(normalized.content).toString("base64");
  await runRemote(
    host,
    `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remoteCodexConfigPath)}`,
  );

  log.dim(`  Normalized ${normalized.changes.length} Codex MCP command path(s):`);
  for (const change of normalized.changes) {
    log.dim(`    ${change}`);
  }
}

async function normalizeRemoteCodexMarketplaceSources(
  host: string,
  remoteCodexConfigPath: string,
  remoteCodexDir: string,
): Promise<void> {
  const existingResult = await runRemote(
    host,
    `if [ -f ${shellQuote(remoteCodexConfigPath)} ]; then cat ${shellQuote(remoteCodexConfigPath)}; fi`,
    { quiet: true },
  );

  if (!existingResult.stdout.trim()) {
    return;
  }

  const normalized = await rewriteCodexMarketplaceSources(existingResult.stdout, async (source) => {
    const target = codexMarketplaceArchivePath(remoteCodexDir, source.name);
    return (await remoteDirectoryExists(host, target)) ? target : null;
  });

  for (const warning of normalized.warnings) {
    log.warn(`[codex] Marketplace source normalization skipped: ${warning}`);
  }

  if (normalized.changes.length === 0) {
    return;
  }

  const b64 = Buffer.from(normalized.content).toString("base64");
  await runRemote(
    host,
    `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remoteCodexConfigPath)}`,
  );

  log.dim(`  Normalized ${normalized.changes.length} Codex marketplace source path(s):`);
  for (const change of normalized.changes) {
    log.dim(`    ${change}`);
  }
}

async function adaptRemoteCodexConfigForHost(
  host: string,
  remoteCodexConfigPath: string,
): Promise<void> {
  const existingResult = await runRemote(
    host,
    `if [ -f ${shellQuote(remoteCodexConfigPath)} ]; then cat ${shellQuote(remoteCodexConfigPath)}; fi`,
    { quiet: true },
  );

  if (!existingResult.stdout.trim()) {
    return;
  }

  const adapted = await adaptCodexConfigForHost(existingResult.stdout, async (path) =>
    remotePathExists(host, path),
  );

  for (const warning of adapted.warnings) {
    log.warn(`[codex] Host adaptation skipped: ${warning}`);
  }

  if (adapted.changes.length === 0) {
    return;
  }

  const b64 = Buffer.from(adapted.content).toString("base64");
  await runRemote(
    host,
    `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remoteCodexConfigPath)}`,
  );

  log.dim(`  Adapted ${adapted.changes.length} Codex host-specific setting(s):`);
  for (const change of adapted.changes) {
    log.dim(`    ${change}`);
  }
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

export function resolvePushActions(input: {
  hasClaude: boolean;
  hasCodex: boolean;
  hasShared: boolean;
}): PushAction[] {
  const actions: PushAction[] = [];

  if (input.hasClaude) {
    actions.push("claude");
  }

  if (input.hasCodex) {
    actions.push("codex");
  }

  if (input.hasShared) {
    actions.push("shared");
  }

  if (input.hasClaude && input.hasShared) {
    actions.push("claude-shared-symlinks");
  }

  return actions;
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
    const remoteCodexConfigPath = join(remoteCodexDir, "config.toml");
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

    for (const action of resolvePushActions({ hasClaude, hasCodex, hasShared })) {
      if (action === "claude") {
        log.info("Syncing Claude provider...");
        await backupDirectoryIfExists(host, remoteClaudeDir);

        const incomingMcpPath = join(remoteClaudeExtract, ".mcp-config.json");
        if (await remotePathExists(host, incomingMcpPath)) {
          await mergeClaudeMcpConfig(host, incomingMcpPath, remoteMcpPath);
        }

        await syncDirectory(host, remoteClaudeExtract, remoteClaudeDir);
      }

      if (action === "codex") {
        log.info("Syncing Codex provider...");
        await backupDirectoryIfExists(host, remoteCodexDir);
        await syncDirectory(host, remoteCodexExtract, remoteCodexDir);
        await normalizeRemoteCodexMcpCommands(host, remoteCodexConfigPath, remoteHome);
        await normalizeRemoteCodexMarketplaceSources(host, remoteCodexConfigPath, remoteCodexDir);
        await adaptRemoteCodexConfigForHost(host, remoteCodexConfigPath);
      }

      if (action === "shared") {
        log.info("Syncing shared agents assets...");
        await backupDirectoryIfExists(host, remoteAgentsDir);
        await syncDirectory(host, remoteSharedExtract, remoteAgentsDir);
      }

      if (action === "claude-shared-symlinks") {
        log.info("Recreating Claude shared skill symlinks...");
        await recreateClaudeSharedSkillSymlinks(host, remoteClaudeDir, remoteAgentsDir);
      }
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
