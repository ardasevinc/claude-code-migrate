import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_COLLECTION_PATHS,
  isProviderName,
  PROVIDERS,
  SHARED_MANAGED_ENTRIES,
} from "../config/providers.ts";
import { CliError, ExecutionError } from "../errors.ts";
import type { ProviderName } from "../types/index.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { log } from "../utils/logger.ts";
import { extractArchive } from "./archiver.ts";
import { pruneLocalBackupsIfParentExists } from "./backup-retention.ts";
import { adaptCodexConfigForHost, normalizeLocalCodexMarketplaceSources } from "./codex.ts";
import { adaptCodexHooksForHost } from "./codex-hooks.ts";
import { mergeMcpServers } from "./mcp.ts";
import { createRuntimeContext } from "../runtime/context.ts";
import { resolveLocalHookCandidate } from "./restore-observation.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir)) {
    await cp(join(sourceDir, entry), join(targetDir, entry), { recursive: true });
  }
}

export async function backupLocalDirectoryIfExists(
  dirPath: string,
  managedEntries?: string[],
): Promise<string | null> {
  if (!(await exists(dirPath))) {
    return null;
  }

  const backupDir = `${dirPath}.backup-${Date.now()}`;
  const unregisterInterruptCleanup = registerInterruptCleanup(async () => {
    await rm(backupDir, { recursive: true, force: true });
  });
  let completed = false;
  try {
    if (managedEntries) {
      await mkdir(backupDir, { recursive: true });
      for (const entry of managedEntries) {
        const source = join(dirPath, entry);
        if (!(await exists(source))) continue;
        const target = join(backupDir, entry);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
      }
    } else {
      await cp(dirPath, backupDir, { recursive: true });
    }
    completed = true;
  } finally {
    if (!completed) await rm(backupDir, { recursive: true, force: true });
    unregisterInterruptCleanup();
  }
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
  let existingRaw = "{}";
  try {
    const stat = await lstat(DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Claude MCP target must be a regular non-symlink file");
    }
    existingRaw = await readFile(DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

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
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "ccm-restore-"));
  const extractionDir = join(tempDir, "archive");
  const unregisterInterruptCleanup = registerInterruptCleanup(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  try {
    const manifest = await extractArchive(archivePath, extractionDir);

    const availableProviders = manifest.providers.filter((p) => isProviderName(p));

    const providersToRestore = resolveProvidersToRestore(availableProviders, provider);

    if (providersToRestore.length === 0) {
      const expected = provider
        ? `Provider '${provider}' not found in archive`
        : "No providers in archive";
      throw new Error(expected);
    }

    const needsShared = providersToRestore.some((name) => PROVIDERS[name].usesSharedSkills);
    const hasClaude = await exists(join(extractionDir, "claude"));
    const hasCodex = await exists(join(extractionDir, "codex"));
    const sharedExtractPath = join(extractionDir, "shared", "agents");
    const hasShared = await exists(sharedExtractPath);

    if (options.dryRun) {
      log.info(`Would restore providers: ${providersToRestore.join(", ")}`);
      if (providersToRestore.includes("claude") && hasClaude) {
        log.dim(`  claude -> ${DEFAULT_COLLECTION_PATHS.claudeDir}`);
        log.dim(`  claude MCP merge -> ${DEFAULT_COLLECTION_PATHS.claudeMcpConfigPath}`);
      }

      if (providersToRestore.includes("codex") && hasCodex) {
        log.dim(`  codex -> ${DEFAULT_COLLECTION_PATHS.codexDir}`);
      }

      if (needsShared && hasShared) {
        log.dim(`  shared agents assets -> ${DEFAULT_COLLECTION_PATHS.sharedAgentsDir}`);
      }

      if (providersToRestore.includes("claude") && hasClaude && needsShared && hasShared) {
        log.dim("  recreate claude shared-skill symlinks");
      }

      return;
    }

    if (providersToRestore.includes("claude") && hasClaude) {
      await backupLocalDirectoryIfExists(DEFAULT_COLLECTION_PATHS.claudeDir, [
        ...PROVIDERS.claude.alwaysInclude,
        ...PROVIDERS.claude.includeIfExists,
        "settings.local.json",
      ]);
      await mergeLocalClaudeMcp(extractionDir);
      await copyDirectoryContents(
        join(extractionDir, "claude"),
        DEFAULT_COLLECTION_PATHS.claudeDir,
      );
      log.success(`Restored Claude provider to ${DEFAULT_COLLECTION_PATHS.claudeDir}`);
    }

    if (providersToRestore.includes("codex") && hasCodex) {
      await backupLocalDirectoryIfExists(DEFAULT_COLLECTION_PATHS.codexDir, [
        ...PROVIDERS.codex.alwaysInclude,
        ...PROVIDERS.codex.includeIfExists,
        ".ccm",
        ".tmp/plugins",
      ]);
      await copyDirectoryContents(join(extractionDir, "codex"), DEFAULT_COLLECTION_PATHS.codexDir);
      const codexConfigPath = join(DEFAULT_COLLECTION_PATHS.codexDir, "config.toml");
      const codexHooksPath = join(DEFAULT_COLLECTION_PATHS.codexDir, "hooks.json");
      if (await exists(codexConfigPath)) {
        const normalized = await normalizeLocalCodexMarketplaceSources(
          codexConfigPath,
          DEFAULT_COLLECTION_PATHS.codexDir,
        );

        for (const warning of normalized.warnings) {
          log.warn(`[codex] Marketplace source normalization skipped: ${warning}`);
        }

        if (normalized.changes.length > 0) {
          log.dim(`  Normalized ${normalized.changes.length} Codex marketplace source path(s)`);
        }

        if (await exists(codexHooksPath)) {
          const hooksRaw = await readFile(codexHooksPath, "utf8");
          const configRaw = await readFile(codexConfigPath, "utf8");
          const context = createRuntimeContext({
            home: join(DEFAULT_COLLECTION_PATHS.codexDir, ".."),
          });
          const hooksAdapted = await adaptCodexHooksForHost(
            hooksRaw,
            configRaw,
            codexHooksPath,
            (binaryName) => resolveLocalHookCandidate(context, binaryName),
            { preserveVerifiedTrust: false },
          );

          for (const warning of hooksAdapted.warnings) {
            log.warn(`[codex] Hook adaptation skipped: ${warning}`);
          }
          await writeFile(codexHooksPath, hooksAdapted.hooksContent, "utf8");
          await writeFile(codexConfigPath, hooksAdapted.configContent, "utf8");
          if (hooksAdapted.changes.length > 0) {
            log.dim(`  Adapted ${hooksAdapted.changes.length} Codex hook command path(s)`);
          }
          if (hooksAdapted.trusted > 0) {
            log.dim(`  Preserved trust for ${hooksAdapted.trusted} verified Codex hook(s)`);
          }
        }

        const rawConfig = await readFile(codexConfigPath, "utf8");
        const adapted = await adaptCodexConfigForHost(rawConfig, exists);

        for (const warning of adapted.warnings) {
          log.warn(`[codex] Host adaptation skipped: ${warning}`);
        }

        if (adapted.changes.length > 0) {
          await writeFile(codexConfigPath, adapted.content, "utf8");
          log.dim(`  Adapted ${adapted.changes.length} Codex host-specific setting(s)`);
        }
      }
      log.success(`Restored Codex provider to ${DEFAULT_COLLECTION_PATHS.codexDir}`);
    }

    if (needsShared && hasShared) {
      await backupLocalDirectoryIfExists(
        DEFAULT_COLLECTION_PATHS.sharedAgentsDir,
        SHARED_MANAGED_ENTRIES,
      );
      await copyDirectoryContents(sharedExtractPath, DEFAULT_COLLECTION_PATHS.sharedAgentsDir);
      log.success(`Restored shared agents assets to ${DEFAULT_COLLECTION_PATHS.sharedAgentsDir}`);
    }

    if (providersToRestore.includes("claude") && hasClaude && needsShared && hasShared) {
      await recreateClaudeSharedSkillSymlinks();
      log.success("Recreated Claude shared skill symlinks");
    }

    return;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new ExecutionError(
      `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    unregisterInterruptCleanup();
  }
}

export function resolveProvidersToRestore(
  availableProviders: ProviderName[],
  provider: ProviderName | undefined,
): ProviderName[] {
  return provider ? (availableProviders.includes(provider) ? [provider] : []) : availableProviders;
}
