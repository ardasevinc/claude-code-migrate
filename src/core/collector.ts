import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { DEFAULT_COLLECTION_PATHS, PROVIDERS, SHARED_ARCHIVE_PREFIX } from "../config/providers.ts";
import type { CollectionPaths, CollectorOptions, FileEntry, ProviderName } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { discoverCodexLocalMarketplaceSources } from "./codex.ts";
import { detectCodexMcpPathWarnings, extractMcpServers } from "./mcp.ts";

interface CollectContext {
  archivePrefix: string;
  basePath: string;
  providerName?: ProviderName;
  neverMigrate?: Set<string>;
  neverMigratePaths?: Set<string>;
  paths: CollectionPaths;
}

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
    await readlink(path);
    return true;
  } catch {
    return false;
  }
}

function isInsidePath(targetPath: string, parentPath: string): boolean {
  if (isPathInside(targetPath, parentPath)) {
    return true;
  }

  const normalizedTarget = normalizePrivatePrefix(targetPath);
  const normalizedParent = normalizePrivatePrefix(parentPath);
  return isPathInside(normalizedTarget, normalizedParent);
}

function isPathInside(targetPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativeInsidePath(targetPath: string, parentPath: string): string {
  if (isPathInside(targetPath, parentPath)) {
    return relative(parentPath, targetPath);
  }

  return relative(normalizePrivatePrefix(parentPath), normalizePrivatePrefix(targetPath));
}

function normalizePrivatePrefix(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

function shouldSkipRelativePath(relativePath: string, neverMigrate?: Set<string>): boolean {
  if (!neverMigrate) {
    return false;
  }

  const firstSegment = relativePath.split("/")[0];
  return firstSegment ? neverMigrate.has(firstSegment) : false;
}

function shouldSkipExactOrNestedPath(
  relativePath: string,
  neverMigratePaths?: Set<string>,
): boolean {
  if (!neverMigratePaths) {
    return false;
  }

  for (const excludedPath of neverMigratePaths) {
    if (relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`)) {
      return true;
    }
  }

  return false;
}

function shouldSkipCollectionPath(context: CollectContext, relativePath: string): boolean {
  return (
    shouldSkipRelativePath(relativePath, context.neverMigrate) ||
    shouldSkipExactOrNestedPath(relativePath, context.neverMigratePaths)
  );
}

function shouldSkipSymlink(
  providerName: ProviderName | undefined,
  relativePath: string,
  resolvedTargetPath: string,
  paths: CollectionPaths,
): boolean {
  if (providerName !== "claude") {
    return false;
  }

  if (!(relativePath === "skills" || relativePath.startsWith("skills/"))) {
    return false;
  }

  return isInsidePath(resolvedTargetPath, paths.sharedSkillsDir);
}

function shouldSkipResolvedSymlink(
  context: CollectContext,
  relativePath: string,
  resolvedPath: string,
): boolean {
  if (shouldSkipSymlink(context.providerName, relativePath, resolvedPath, context.paths)) {
    return true;
  }

  if (!isInsidePath(resolvedPath, context.basePath)) {
    return true;
  }

  const resolvedRelativePath = relativeInsidePath(resolvedPath, context.basePath);
  return shouldSkipCollectionPath(context, resolvedRelativePath);
}

function pushEntry(
  entries: FileEntry[],
  context: CollectContext,
  sourcePath: string,
  relativePath: string,
  isLink: boolean,
  linkTarget?: string,
): void {
  entries.push({
    sourcePath,
    relativePath: join(context.archivePrefix, relativePath),
    isSymlink: isLink,
    originalSymlinkTarget: linkTarget,
  });
}

async function collectDirectory(
  dirPath: string,
  entries: FileEntry[],
  context: CollectContext,
  virtualPrefix?: string,
): Promise<void> {
  const dirEntries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of dirEntries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = virtualPrefix
      ? join(virtualPrefix, entry.name)
      : relative(context.basePath, fullPath);

    if (shouldSkipCollectionPath(context, relativePath)) {
      continue;
    }

    const target = await readlink(fullPath).catch(() => null);

    if (target !== null) {
      const resolvedPath = await realpath(fullPath).catch(() => null);

      if (!resolvedPath || !(await exists(resolvedPath))) {
        continue;
      }

      if (shouldSkipResolvedSymlink(context, relativePath, resolvedPath)) {
        continue;
      }

      const resolvedStat = await lstat(resolvedPath);

      if (resolvedStat.isDirectory()) {
        await collectDirectory(resolvedPath, entries, context, relativePath);
      } else {
        pushEntry(entries, context, resolvedPath, relativePath, true, target);
      }

      continue;
    }

    const stat = await lstat(fullPath);

    if (stat.isDirectory()) {
      await collectDirectory(fullPath, entries, context, relativePath);
      continue;
    }

    pushEntry(entries, context, fullPath, relativePath, false);
  }
}

async function collectPath(
  fullPath: string,
  entries: FileEntry[],
  context: CollectContext,
): Promise<void> {
  if (!(await exists(fullPath))) {
    return;
  }

  const relativePath = relative(context.basePath, fullPath);

  if (shouldSkipCollectionPath(context, relativePath)) {
    return;
  }

  if (await isSymlink(fullPath)) {
    const linkTarget = await readlink(fullPath);
    const resolvedPath = await realpath(fullPath).catch(() => null);

    if (!resolvedPath || !(await exists(resolvedPath))) {
      return;
    }

    if (shouldSkipResolvedSymlink(context, relativePath, resolvedPath)) {
      return;
    }

    const resolvedStat = await lstat(resolvedPath);

    if (resolvedStat.isDirectory()) {
      await collectDirectory(resolvedPath, entries, context, relativePath);
      return;
    }

    pushEntry(entries, context, resolvedPath, relativePath, true, linkTarget);
    return;
  }

  if (await isDirectory(fullPath)) {
    await collectDirectory(fullPath, entries, context, relativePath);
    return;
  }

  pushEntry(entries, context, fullPath, relativePath, false);
}

function getProviderBasePath(providerName: ProviderName, paths: CollectionPaths): string {
  if (providerName === "claude") {
    return paths.claudeDir;
  }

  return paths.codexDir;
}

async function collectProviderFiles(
  providerName: ProviderName,
  options: CollectorOptions,
  paths: CollectionPaths,
): Promise<FileEntry[]> {
  const provider = PROVIDERS[providerName];
  const basePath = getProviderBasePath(providerName, paths);
  const entries: FileEntry[] = [];

  if (!(await exists(basePath))) {
    log.warn(`[${providerName}] Provider directory not found: ${basePath}`);
    return entries;
  }

  const context: CollectContext = {
    archivePrefix: providerName,
    basePath,
    providerName,
    neverMigrate: new Set(provider.neverMigrate),
    neverMigratePaths: new Set(provider.neverMigratePaths ?? []),
    paths,
  };

  for (const item of provider.alwaysInclude) {
    const fullPath = join(basePath, item);

    if (!(await exists(fullPath))) {
      if (!options.dryRun) {
        log.warn(`[${providerName}] Missing required: ${item}`);
      }
      continue;
    }

    await collectPath(fullPath, entries, context);
  }

  for (const item of provider.includeIfExists) {
    const fullPath = join(basePath, item);
    if (await exists(fullPath)) {
      await collectPath(fullPath, entries, context);
    }
  }

  if (providerName === "claude") {
    if (options.includeClaudeSettingsLocal) {
      const settingsLocalPath = join(basePath, "settings.local.json");
      await collectPath(settingsLocalPath, entries, context);
    }

    if (options.includeClaudeMcpConfig && (await exists(paths.claudeMcpConfigPath))) {
      const { mcpServers, warnings } = await extractMcpServers(paths.claudeMcpConfigPath);

      if (warnings.length > 0) {
        log.warn("[claude] MCP servers with paths that may not work on remote:");
        for (const warning of warnings) {
          log.dim(`  ${warning}`);
        }
      }

      if (mcpServers && Object.keys(mcpServers).length > 0) {
        entries.push({
          sourcePath: paths.claudeMcpConfigPath,
          relativePath: join(providerName, ".mcp-config.json"),
          isSymlink: false,
          mcpServersOnly: JSON.stringify({ mcpServers }, null, 2),
        });
      }
    }
  }

  if (providerName === "codex") {
    const codexConfigPath = join(basePath, "config.toml");
    const warnings = await detectCodexMcpPathWarnings(codexConfigPath);

    if (warnings.length > 0) {
      log.warn("[codex] MCP servers with paths that may not work on remote:");
      for (const warning of warnings) {
        log.dim(`  ${warning}`);
      }
    }

    for (const marketplaceSource of await discoverCodexLocalMarketplaceSources(codexConfigPath)) {
      if (!(await isDirectory(marketplaceSource.source))) {
        log.warn(
          `[codex] Marketplace source not found, skipping: ${marketplaceSource.name} (${marketplaceSource.source})`,
        );
        continue;
      }

      await collectDirectory(marketplaceSource.source, entries, {
        archivePrefix: join(providerName, ".ccm", "marketplaces", marketplaceSource.name),
        basePath: marketplaceSource.source,
        paths,
      });
    }
  }

  return entries;
}

async function collectSharedAgentsFiles(paths: CollectionPaths): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  if (await exists(paths.sharedSkillsDir)) {
    const context: CollectContext = {
      archivePrefix: join(SHARED_ARCHIVE_PREFIX, "skills"),
      basePath: paths.sharedSkillsDir,
      paths,
    };

    await collectDirectory(paths.sharedSkillsDir, entries, context);
  }

  if (await exists(paths.sharedLazySkillsDir)) {
    const context: CollectContext = {
      archivePrefix: join(SHARED_ARCHIVE_PREFIX, "lazy-skills"),
      basePath: paths.sharedLazySkillsDir,
      paths,
    };

    await collectDirectory(paths.sharedLazySkillsDir, entries, context);
  }

  if (await exists(paths.sharedSkillLockPath)) {
    entries.push({
      sourcePath: paths.sharedSkillLockPath,
      relativePath: join(SHARED_ARCHIVE_PREFIX, ".skill-lock.json"),
      isSymlink: false,
    });
  }

  return entries;
}

export async function collectFiles(options: CollectorOptions): Promise<FileEntry[]> {
  const paths: CollectionPaths = {
    ...DEFAULT_COLLECTION_PATHS,
    ...options.paths,
  };

  const entries: FileEntry[] = [];

  for (const providerName of options.providers) {
    const providerEntries = await collectProviderFiles(providerName, options, paths);
    entries.push(...providerEntries);
  }

  const needsSharedSkills = options.providers.some(
    (providerName) => PROVIDERS[providerName].usesSharedSkills,
  );
  if (needsSharedSkills) {
    const sharedEntries = await collectSharedAgentsFiles(paths);
    entries.push(...sharedEntries);
  }

  return entries;
}
