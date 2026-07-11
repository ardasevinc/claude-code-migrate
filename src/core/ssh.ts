import { join } from "node:path";
import type { FileEntry } from "../types/index.ts";
import type { CodexPluginPolicy } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
import { buildRemoteBackupPruneCommand } from "./backup-retention.ts";
import {
  adaptCodexConfigForHost,
  codexMarketplaceArchivePath,
  getCodexLocalMarketplaceSources,
  rewriteCodexMarketplaceSources,
} from "./codex.ts";
import {
  applyCodexPluginPolicies,
  codexPluginPolicyCommandNames,
  type HostCapabilities,
  mergeCodexPluginPolicies,
} from "./codex-plugin-policy.ts";
import { mergeMcpServers, normalizeCodexMcpCommandPaths } from "./mcp.ts";
import { validateArchive } from "./archiver.ts";

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

export async function pushArchive(
  archivePath: string,
  host: string,
  options: { codexPluginPolicies?: Record<string, CodexPluginPolicy> } = {},
): Promise<boolean> {
  const remoteTempArchive = `/tmp/ccm-archive-${Date.now()}.tar.gz`;
  const remoteTempDir = `/tmp/ccm-extract-${Date.now()}`;

  try {
    await validateArchive(archivePath);
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
        const previousRemoteCodexConfig = await readRemoteFileIfExists(host, remoteCodexConfigPath);
        await syncDirectory(host, remoteCodexExtract, remoteCodexDir);
        await normalizeRemoteCodexMcpCommands(host, remoteCodexConfigPath, remoteHome);
        await normalizeRemoteCodexMarketplaceSources(host, remoteCodexConfigPath, remoteCodexDir);
        await adaptRemoteCodexConfigForHost(host, remoteCodexConfigPath);
        await reconcileRemoteCodexPlugins(host, remoteCodexConfigPath, remoteHome, {
          pluginPolicies: options.codexPluginPolicies,
          preserveConfigRaw: previousRemoteCodexConfig,
        });
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

export async function previewRemoteCodexPluginPolicy(
  host: string,
  rawConfig: string,
  pluginPolicies: Record<string, CodexPluginPolicy> = {},
): Promise<void> {
  try {
    const remoteHome = await getRemoteHome(host);
    const remoteCodexConfigPath = join(remoteHome, ".codex", "config.toml");
    const previousRemoteCodexConfig = await readRemoteFileIfExists(host, remoteCodexConfigPath);
    const policies = mergeCodexPluginPolicies(pluginPolicies);
    const capabilities = await probeRemoteHostCapabilities(
      host,
      codexPluginPolicyCommandNames(policies),
    );
    const applied = applyCodexPluginPolicies(rawConfig, capabilities, policies, {
      preserveConfigRaw: previousRemoteCodexConfig,
    });
    const incomingLocalMarketplaces = new Set(
      getCodexLocalMarketplaceSources(rawConfig, remoteHome).map((source) => source.name),
    );

    log.info(`Codex plugin policy preview for ${host} (${capabilities.os}/${capabilities.arch})`);
    log.dim(
      `  gui=${capabilities.gui}; commands=${capabilities.commands.length > 0 ? capabilities.commands.join(",") : "none"}`,
    );

    if (applied.decisions.length === 0) {
      log.dim("  no enabled Codex plugins matched policy evaluation");
      return;
    }

    for (const decision of applied.decisions) {
      const state = decision.enabled ? "enabled" : "disabled";
      log.dim(`  ${decision.pluginId}: ${state} (${decision.reason})`);
    }

    const pluginsToInstall = applied.decisions
      .filter((decision) => decision.enabled && decision.action !== "preserve")
      .map((decision) => decision.pluginId);
    if (pluginsToInstall.length === 0) {
      return;
    }

    await previewMissingRemoteCodexPlugins(host, remoteHome, pluginsToInstall, {
      incomingLocalMarketplaces,
    });
  } catch (error) {
    log.warn(`[codex] Plugin policy dry-run preview skipped: ${error}`);
  }
}

function pluginMarketplaceName(pluginId: string): string | null {
  const separatorIndex = pluginId.lastIndexOf("@");
  if (separatorIndex === -1 || separatorIndex === pluginId.length - 1) {
    return null;
  }
  return pluginId.slice(separatorIndex + 1);
}

async function reconcileRemoteCodexPlugins(
  host: string,
  remoteCodexConfigPath: string,
  remoteHome: string,
  options: { pluginPolicies?: Record<string, CodexPluginPolicy>; preserveConfigRaw?: string },
): Promise<void> {
  const rawConfig = await readRemoteFileIfExists(host, remoteCodexConfigPath);
  if (!rawConfig.trim()) {
    return;
  }

  const policies = mergeCodexPluginPolicies(options.pluginPolicies);
  const capabilities = await probeRemoteHostCapabilities(
    host,
    codexPluginPolicyCommandNames(policies),
  );
  const applied = applyCodexPluginPolicies(rawConfig, capabilities, policies, {
    preserveConfigRaw: options.preserveConfigRaw,
  });

  for (const warning of applied.warnings) {
    log.warn(`[codex] Plugin policy skipped: ${warning}`);
  }

  if (applied.changes.length > 0) {
    await writeRemoteFile(host, remoteCodexConfigPath, applied.content);
    log.dim(
      `  Applied ${applied.changes.length} Codex plugin host policy change(s) for ${capabilities.os}/${capabilities.arch}`,
    );
    for (const change of applied.changes) {
      log.dim(`    ${change}`);
    }
  }

  const pluginsToInstall = applied.decisions
    .filter((decision) => decision.enabled && decision.action !== "preserve")
    .map((decision) => decision.pluginId);

  if (pluginsToInstall.length === 0) {
    return;
  }

  await installMissingRemoteCodexPlugins(host, remoteHome, pluginsToInstall);
}

async function previewMissingRemoteCodexPlugins(
  host: string,
  remoteHome: string,
  pluginIds: string[],
  options: { incomingLocalMarketplaces?: Set<string> } = {},
): Promise<void> {
  const codexCommand = await resolveRemoteCodexCommand(host, remoteHome);
  if (!codexCommand) {
    log.warn("[codex] Plugin install preview skipped: codex command not found on remote");
    return;
  }

  const listResult = await runRemote(
    host,
    `${shellQuote(codexCommand)} plugin list --available --json`,
    {
      quiet: true,
      nothrow: true,
    },
  );
  if (listResult.exitCode !== 0) {
    log.warn(`[codex] Plugin install preview skipped: ${listResult.stderr || listResult.stdout}`);
    return;
  }

  const list = parseCodexPluginList(listResult.stdout);
  const installed = new Set(list.installed.map((plugin) => plugin.pluginId));
  const available = new Set(list.available.map((plugin) => plugin.pluginId));

  log.info("Plugin install plan:");
  for (const pluginId of pluginIds) {
    if (installed.has(pluginId)) {
      log.dim(`  ${pluginId}: already installed`);
    } else if (available.has(pluginId)) {
      log.dim(`  ${pluginId}: would install`);
    } else if (options.incomingLocalMarketplaces?.has(pluginMarketplaceName(pluginId) ?? "")) {
      log.dim(`  ${pluginId}: would install after syncing local marketplace source`);
    } else {
      log.warn(`[codex] Plugin install would be skipped: ${pluginId} is not available on remote`);
    }
  }
}

async function probeRemoteHostCapabilities(
  host: string,
  commandNames: string[],
): Promise<HostCapabilities> {
  const result = await runRemote(host, buildRemoteHostCapabilityProbeCommand(commandNames), {
    quiet: true,
  });

  const commands: string[] = [];
  let os = "unknown";
  let arch = "unknown";
  let gui = false;

  for (const line of result.stdout.split("\n")) {
    const [key, value = ""] = line.trim().split("=", 2);
    if (key === "os") {
      os = normalizeHostOs(value);
    } else if (key === "arch") {
      arch = value || "unknown";
    } else if (key === "gui") {
      gui = value === "true";
    } else if (key === "cmd" && value) {
      commands.push(value);
    }
  }

  return { os, arch, gui, commands };
}

export function buildRemoteHostCapabilityProbeCommand(commandNames: string[]): string {
  const commandChecks = commandNames
    .map(
      (command) =>
        `if command -v ${shellQuote(command)} >/dev/null 2>&1; then echo cmd=${shellQuote(command)}; fi`,
    )
    .join("; ");

  return [
    `printf 'os=%s\\n' "$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo unknown)"`,
    `printf 'arch=%s\\n' "$(uname -m 2>/dev/null || echo unknown)"`,
    `if [ -n "\${DISPLAY:-}" ] || [ -n "\${WAYLAND_DISPLAY:-}" ] || [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then echo gui=true; else echo gui=false; fi`,
    commandChecks,
  ]
    .filter(Boolean)
    .join("; ");
}

async function installMissingRemoteCodexPlugins(
  host: string,
  remoteHome: string,
  pluginIds: string[],
): Promise<void> {
  const codexCommand = await resolveRemoteCodexCommand(host, remoteHome);
  if (!codexCommand) {
    log.warn("[codex] Plugin install reconciliation skipped: codex command not found on remote");
    return;
  }

  const listResult = await runRemote(
    host,
    `${shellQuote(codexCommand)} plugin list --available --json`,
    {
      quiet: true,
      nothrow: true,
    },
  );
  if (listResult.exitCode !== 0) {
    log.warn(
      `[codex] Plugin install reconciliation skipped: ${listResult.stderr || listResult.stdout}`,
    );
    return;
  }

  const list = parseCodexPluginList(listResult.stdout);
  const installed = new Set(list.installed.map((plugin) => plugin.pluginId));
  const available = new Set(list.available.map((plugin) => plugin.pluginId));
  const toInstall = pluginIds.filter(
    (pluginId) => !installed.has(pluginId) && available.has(pluginId),
  );

  for (const pluginId of pluginIds) {
    if (!installed.has(pluginId) && !available.has(pluginId)) {
      log.warn(`[codex] Plugin install skipped: ${pluginId} is not available on remote`);
    }
  }

  if (toInstall.length === 0) {
    return;
  }

  log.dim(`  Installing ${toInstall.length} missing Codex plugin(s) on remote`);
  for (const pluginId of toInstall) {
    const result = await runRemote(
      host,
      `${shellQuote(codexCommand)} plugin add ${shellQuote(pluginId)} --json >/dev/null`,
      { quiet: true, nothrow: true },
    );
    if (result.exitCode === 0) {
      log.dim(`    installed ${pluginId}`);
    } else {
      log.warn(`[codex] Plugin install failed for ${pluginId}: ${result.stderr || result.stdout}`);
    }
  }
}

async function resolveRemoteCodexCommand(host: string, remoteHome: string): Promise<string | null> {
  const result = await runRemote(
    host,
    buildRemoteCommandPathResolutionCommand("codex", remoteHome),
    {
      quiet: true,
      nothrow: true,
    },
  );
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

async function readRemoteFileIfExists(host: string, path: string): Promise<string> {
  const result = await runRemote(
    host,
    `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; fi`,
    { quiet: true },
  );
  return result.stdout;
}

async function writeRemoteFile(host: string, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content).toString("base64");
  await runRemote(host, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`);
}

function parseCodexPluginList(raw: string): {
  installed: Array<{ pluginId: string }>;
  available: Array<{ pluginId: string }>;
} {
  try {
    const parsed = JSON.parse(raw) as {
      installed?: Array<{ pluginId?: string }>;
      available?: Array<{ pluginId?: string }>;
    };
    return {
      installed: (parsed.installed ?? []).flatMap((plugin) =>
        typeof plugin.pluginId === "string" ? [{ pluginId: plugin.pluginId }] : [],
      ),
      available: (parsed.available ?? []).flatMap((plugin) =>
        typeof plugin.pluginId === "string" ? [{ pluginId: plugin.pluginId }] : [],
      ),
    };
  } catch {
    return { installed: [], available: [] };
  }
}

function normalizeHostOs(value: string): string {
  if (value === "darwin") {
    return "darwin";
  }
  if (value === "linux") {
    return "linux";
  }
  if (value.startsWith("mingw") || value.startsWith("msys") || value.startsWith("cygwin")) {
    return "windows";
  }
  return value || "unknown";
}

interface PushPreviewOptions {
  verbose?: boolean;
}

interface TransferGroup {
  label: string;
  count: number;
}

function displayTransferPath(file: FileEntry): string {
  return file.relativePath === "claude/.mcp-config.json"
    ? "~/.claude.json (MCP)"
    : file.relativePath;
}

function transferGroupLabel(relativePath: string): string {
  const parts = relativePath.split("/");

  if (parts[0] === "codex" && parts[1] === ".ccm" && parts[2] === "marketplaces" && parts[3]) {
    return `codex marketplaces/${parts[3]}`;
  }

  if (parts[0] === "shared" && parts[1] === "agents" && parts[2]) {
    return `shared agents/${parts[2]}`;
  }

  if (parts[0] === "claude" && parts[1]) {
    return `claude/${parts[1]}`;
  }

  if (parts[0] === "codex" && parts[1]) {
    return `codex/${parts[1]}`;
  }

  return parts[0] || "other";
}

function summarizeTransferGroups(files: FileEntry[]): TransferGroup[] {
  const counts = new Map<string, number>();

  for (const file of files) {
    const label = transferGroupLabel(file.relativePath);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function summarizeProviderCounts(files: FileEntry[]): TransferGroup[] {
  const counts = new Map<string, number>();

  for (const file of files) {
    const provider = file.relativePath.split("/")[0] || "other";
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export async function previewPush(
  files: FileEntry[],
  host: string,
  options: PushPreviewOptions = {},
): Promise<void> {
  log.info(`Push dry-run for ${host}`);
  log.dim(`  transfer: ${formatCount(files.length, "file")}`);

  const providerCounts = summarizeProviderCounts(files)
    .map((group) => `${group.label} ${group.count.toLocaleString()}`)
    .join(", ");
  if (providerCounts) {
    log.dim(`  archive areas: ${providerCounts}`);
  }

  const symlinkCount = files.filter((file) => file.isSymlink).length;
  if (symlinkCount > 0) {
    log.dim(`  symlinks: ${symlinkCount.toLocaleString()}`);
  }

  const groups = summarizeTransferGroups(files);
  log.info("Transfer summary:");
  for (const group of groups.slice(0, 12)) {
    log.dim(`  ${group.label}: ${formatCount(group.count, "file")}`);
  }
  if (groups.length > 12) {
    log.dim(`  ... ${groups.length - 12} more group${groups.length - 12 === 1 ? "" : "s"}`);
  }

  if (!options.verbose) {
    log.info("Sample paths:");
    for (const file of files.slice(0, 12)) {
      const symlinkNote = file.isSymlink ? ` (symlink -> ${file.originalSymlinkTarget})` : "";
      log.file(displayTransferPath(file), symlinkNote);
    }
    if (files.length > 12) {
      log.dim(
        `  ... ${formatCount(files.length - 12, "more file")} hidden; use --verbose to list all`,
      );
    }
    return;
  }

  log.info(`Files to transfer (${files.length.toLocaleString()}):`);
  for (const file of files) {
    const symlinkNote = file.isSymlink ? ` (symlink -> ${file.originalSymlinkTarget})` : "";
    log.file(displayTransferPath(file), symlinkNote);
  }
}
