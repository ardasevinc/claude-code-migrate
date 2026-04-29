import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COLLECTION_PATHS, isProviderName, PROVIDERS } from "../config/providers.ts";
import type { ProviderName } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
import { extractArchive } from "./archiver.ts";
import { pruneLocalBackupsIfParentExists } from "./backup-retention.ts";
import { mergeMcpServers } from "./mcp.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await runCommand(`mkdir -p ${shellQuote(targetDir)}`);
  await runCommand(`cp -r ${shellQuote(sourceDir)}/. ${shellQuote(targetDir)}/`);
}

export async function backupLocalDirectoryIfExists(dirPath: string): Promise<string | null> {
  if (!(await exists(dirPath))) {
    return null;
  }

  const backupDir = `${dirPath}.backup-${Date.now()}`;
  await runCommand(`cp -r ${shellQuote(dirPath)} ${shellQuote(backupDir)}`, { quiet: true });
  log.dim(`  Backed up ${dirPath} -> ${backupDir}`);
  await pruneLocalBackupsIfParentExists(dirPath);
  return backupDir;
}

async function mergeLocalClaudeMcp(extractRoot: string): Promise<void> {
  const incomingPath = join(extractRoot, "claude", ".mcp-config.json");

  if (!(await exists(incomingPath))) {
    return;
  }

  const incomingRaw = await readFile(incomingPath, "utf8");
  const existingRaw = (await exists(DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath))
    ? await readFile(DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath, "utf8")
    : "{}";

  const merged = mergeMcpServers(existingRaw, incomingRaw);
  await writeFile(DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath, merged, "utf8");
  await rm(incomingPath, { force: true });

  const incoming = JSON.parse(incomingRaw) as { mcpServers?: Record<string, unknown> };
  const serverCount = Object.keys(incoming.mcpServers ?? {}).length;
  log.dim(
    `  Merged ${serverCount} MCP server(s) into ${DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath}`,
  );
}

async function recreateClaudeSharedSkillSymlinks(): Promise<void> {
  const claudeSkillsDir = join(DEFAULT_COLLECTION_PATHS.claudeDir, "skills");
  const sharedSkillsDir = DEFAULT_COLLECTION_PATHS.sharedSkillsDir;

  if (!(await exists(sharedSkillsDir))) {
    return;
  }

  await mkdir(claudeSkillsDir, { recursive: true });

  const skills = await readdir(sharedSkillsDir, { withFileTypes: true });
  for (const skill of skills) {
    if (!skill.isDirectory()) {
      continue;
    }

    const sourcePath = join(sharedSkillsDir, skill.name);
    const targetPath = join(claudeSkillsDir, skill.name);

    if (await exists(targetPath)) {
      await rm(targetPath, { recursive: true, force: true });
    }

    await symlink(sourcePath, targetPath);
  }
}

export async function restoreArchive(
  archivePath: string,
  provider: ProviderName | undefined,
  options: { dryRun?: boolean } = {},
): Promise<boolean> {
  const tempDir = join(tmpdir(), `ccm-restore-${Date.now()}`);

  try {
    const manifest = await extractArchive(archivePath, tempDir);
    if (!manifest) {
      log.error("Invalid archive or manifest missing");
      return false;
    }

    const availableProviders = manifest.providers.filter((p) => isProviderName(p));

    const providersToRestore = resolveProvidersToRestore(availableProviders, provider);

    if (providersToRestore.length === 0) {
      const expected = provider
        ? `Provider '${provider}' not found in archive`
        : "No providers in archive";
      log.error(expected);
      return false;
    }

    const needsShared = providersToRestore.some((name) => PROVIDERS[name].usesSharedSkills);
    const sharedExtractPath = join(tempDir, "shared", "agents");
    const hasShared = await exists(sharedExtractPath);

    if (options.dryRun) {
      log.info(`Would restore providers: ${providersToRestore.join(", ")}`);
      if (providersToRestore.includes("claude")) {
        log.dim(`  claude -> ${DEFAULT_COLLECTION_PATHS.claudeDir}`);
        log.dim(`  claude MCP merge -> ${DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath}`);
      }

      if (providersToRestore.includes("codex")) {
        log.dim(`  codex -> ${DEFAULT_COLLECTION_PATHS.codexDir}`);
      }

      if (needsShared && hasShared) {
        log.dim(`  shared skills -> ${DEFAULT_COLLECTION_PATHS.sharedAgentsDir}`);
      }

      if (providersToRestore.includes("claude") && needsShared && hasShared) {
        log.dim("  recreate claude shared-skill symlinks");
      }

      return true;
    }

    if (providersToRestore.includes("claude")) {
      await backupLocalDirectoryIfExists(DEFAULT_COLLECTION_PATHS.claudeDir);
      await mergeLocalClaudeMcp(tempDir);
      await copyDirectoryContents(join(tempDir, "claude"), DEFAULT_COLLECTION_PATHS.claudeDir);
      log.success(`Restored Claude provider to ${DEFAULT_COLLECTION_PATHS.claudeDir}`);
    }

    if (providersToRestore.includes("codex")) {
      await backupLocalDirectoryIfExists(DEFAULT_COLLECTION_PATHS.codexDir);
      await copyDirectoryContents(join(tempDir, "codex"), DEFAULT_COLLECTION_PATHS.codexDir);
      log.success(`Restored Codex provider to ${DEFAULT_COLLECTION_PATHS.codexDir}`);
    }

    if (needsShared && hasShared) {
      await backupLocalDirectoryIfExists(DEFAULT_COLLECTION_PATHS.sharedAgentsDir);
      await copyDirectoryContents(sharedExtractPath, DEFAULT_COLLECTION_PATHS.sharedAgentsDir);
      log.success(`Restored shared skills to ${DEFAULT_COLLECTION_PATHS.sharedAgentsDir}`);
    }

    if (providersToRestore.includes("claude") && needsShared && hasShared) {
      await recreateClaudeSharedSkillSymlinks();
      log.success("Recreated Claude shared skill symlinks");
    }

    return true;
  } catch (error) {
    log.error(`Restore failed: ${error}`);
    return false;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function resolveProvidersToRestore(
  availableProviders: ProviderName[],
  provider: ProviderName | undefined,
): ProviderName[] {
  return provider ? (availableProviders.includes(provider) ? [provider] : []) : availableProviders;
}
