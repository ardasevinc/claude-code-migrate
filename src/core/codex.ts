import { lstat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

const LOCAL_PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;
const SAFE_MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

interface CodexMarketplaceConfig {
  source_type?: string;
  source?: string;
}

interface CodexMcpServerConfig {
  command?: string;
}

interface CodexConfig {
  marketplaces?: Record<string, CodexMarketplaceConfig>;
  mcp_servers?: Record<string, CodexMcpServerConfig>;
  mcpServers?: Record<string, CodexMcpServerConfig>;
  notify?: string[];
  plugins?: Record<string, { enabled?: boolean }>;
}

export interface CodexLocalMarketplaceSource {
  name: string;
  rawSource: string;
  source: string;
}

export function getConfiguredCodexPluginNames(
  rawConfig: string,
  marketplaceName: string,
): string[] {
  const parsed = parse(rawConfig) as unknown as CodexConfig;
  const suffix = `@${marketplaceName}`;
  return Object.entries(parsed.plugins ?? {})
    .filter(([id, state]) => id.endsWith(suffix) && state?.enabled !== false)
    .map(([id]) => id.slice(0, -suffix.length));
}

export interface CodexMarketplaceSourceRewrite {
  content: string;
  changes: string[];
  warnings: string[];
}

export interface CodexHostAdaptation {
  content: string;
  changes: string[];
  warnings: string[];
}

export async function discoverCodexLocalMarketplaceSources(
  configPath: string,
): Promise<CodexLocalMarketplaceSource[]> {
  try {
    const raw = await readFile(configPath, "utf8");
    return getCodexLocalMarketplaceSources(raw, dirname(configPath));
  } catch {
    return [];
  }
}

export function getCodexLocalMarketplaceSources(
  rawConfig: string,
  configDir: string,
): CodexLocalMarketplaceSource[] {
  const parsed = parse(rawConfig) as unknown as CodexConfig;
  const marketplaces = parsed.marketplaces ?? {};
  const sources: CodexLocalMarketplaceSource[] = [];

  for (const [name, marketplace] of Object.entries(marketplaces)) {
    if (!SAFE_MARKETPLACE_NAME_PATTERN.test(name)) {
      continue;
    }

    if (marketplace?.source_type !== "local" || typeof marketplace.source !== "string") {
      continue;
    }

    if (!LOCAL_PATH_PATTERN.test(marketplace.source)) {
      continue;
    }

    sources.push({
      name,
      rawSource: marketplace.source,
      source: resolveCodexConfigPath(marketplace.source, configDir),
    });
  }

  return sources;
}

export async function normalizeLocalCodexMarketplaceSources(
  configPath: string,
  codexDir: string,
): Promise<CodexMarketplaceSourceRewrite> {
  const raw = await readFile(configPath, "utf8");
  const normalized = await rewriteCodexMarketplaceSources(raw, async (source) => {
    const target = codexMarketplaceArchivePath(codexDir, source.name);
    return (await exists(target)) ? target : null;
  });

  if (normalized.changes.length > 0) {
    await writeFile(configPath, normalized.content, "utf8");
  }

  return normalized;
}

export async function rewriteCodexMarketplaceSources(
  rawConfig: string,
  resolveMarketplaceSource: (source: CodexLocalMarketplaceSource) => Promise<string | null>,
): Promise<CodexMarketplaceSourceRewrite> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let content = rawConfig;

  for (const source of getCodexLocalMarketplaceSources(rawConfig, homedir())) {
    const rewrittenSource = await resolveMarketplaceSource(source);

    if (!rewrittenSource) {
      warnings.push(`${source.name}: archived marketplace source not found`);
      continue;
    }

    if (rewrittenSource === source.source) {
      continue;
    }

    const nextContent = replaceCodexMarketplaceSource(
      content,
      source.name,
      source.rawSource,
      rewrittenSource,
    );

    if (nextContent === content) {
      warnings.push(`${source.name}: could not rewrite marketplace source "${source.source}"`);
      continue;
    }

    content = nextContent;
    changes.push(`${source.name}: ${source.source} -> ${rewrittenSource}`);
  }

  return { content, changes, warnings };
}

export async function adaptCodexConfigForHost(
  rawConfig: string,
  pathExists: (path: string) => Promise<boolean>,
  options: { removeUnresolvedRelativePaths?: boolean } = {},
): Promise<CodexHostAdaptation> {
  const parsed = parse(rawConfig) as unknown as CodexConfig;
  const changes: string[] = [];
  const warnings: string[] = [];
  let content = rawConfig;

  const notifyCommand = parsed.notify?.[0];
  if (
    typeof notifyCommand === "string" &&
    LOCAL_PATH_PATTERN.test(notifyCommand) &&
    (isClearlyNonPortableCodexPath(notifyCommand) ||
      (options.removeUnresolvedRelativePaths && isRelativeCodexPath(notifyCommand))) &&
    !(await pathExists(notifyCommand))
  ) {
    const nextContent = removeTopLevelTomlAssignment(content, "notify");
    if (nextContent === content) {
      warnings.push(`notify: could not remove missing command "${notifyCommand}"`);
    } else {
      content = nextContent;
      changes.push(`notify: removed missing command ${notifyCommand}`);
    }
  }

  const mcpServers = parsed.mcp_servers ?? parsed.mcpServers ?? {};
  for (const [name, server] of Object.entries(mcpServers)) {
    const command = server.command;
    if (
      typeof command === "string" &&
      LOCAL_PATH_PATTERN.test(command) &&
      (isClearlyNonPortableCodexPath(command) ||
        (options.removeUnresolvedRelativePaths && isRelativeCodexPath(command))) &&
      !(await pathExists(command))
    ) {
      const nextContent = removeTomlSectionTree(content, "mcp_servers", name);
      if (nextContent === content) {
        warnings.push(`${name}: could not remove missing MCP command "${command}"`);
      } else {
        content = nextContent;
        changes.push(`${name}: removed missing MCP command ${command}`);
      }
    }
  }

  return { content, changes, warnings };
}

export function codexMarketplaceArchivePath(codexDir: string, marketplaceName: string): string {
  return join(codexDir, ".ccm", "marketplaces", marketplaceName);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexConfigPath(value: string, configDir: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }

  if (isAbsolute(value)) {
    return value;
  }

  return resolve(configDir, value);
}

function replaceCodexMarketplaceSource(
  rawConfig: string,
  marketplaceName: string,
  oldSource: string,
  newSource: string,
): string {
  const namePattern = `${escapeRegExp(marketplaceName)}|${escapeRegExp(JSON.stringify(marketplaceName))}`;
  const sectionPattern = new RegExp(
    `(^\\[marketplaces\\.(?:${namePattern})\\]\\n)([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m",
  );
  const sectionMatch = rawConfig.match(sectionPattern);

  if (!sectionMatch) {
    return rawConfig;
  }

  const [section, header = "", body = ""] = sectionMatch;
  const sourcePattern = new RegExp(
    `(^\\s*source\\s*=\\s*)${escapeRegExp(JSON.stringify(oldSource))}(\\s*(?:#.*)?$)`,
    "m",
  );
  const nextBody = body.replace(sourcePattern, `$1${JSON.stringify(newSource)}$2`);

  if (nextBody === body) {
    return rawConfig;
  }

  return rawConfig.replace(section, `${header}${nextBody}`);
}

function removeTopLevelTomlAssignment(rawConfig: string, key: string): string {
  const assignmentPattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*.*(?:\\n|$)`, "m");
  return rawConfig.replace(assignmentPattern, "");
}

function removeTomlSectionTree(rawConfig: string, tableName: string, sectionName: string): string {
  const sectionPattern = new RegExp(
    `^\\[${escapeRegExp(tableName)}\\.(?:${tomlSectionNamePattern(sectionName)})(?:\\.[^\\]]+)?\\]\\n[\\s\\S]*?(?=^\\[[^\\n]+\\]|(?![\\s\\S]))`,
    "gm",
  );
  return rawConfig.replace(sectionPattern, "");
}

function tomlSectionNamePattern(value: string): string {
  return `${escapeRegExp(value)}|${escapeRegExp(JSON.stringify(value))}`;
}

function isClearlyNonPortableCodexPath(path: string): boolean {
  return (
    path.startsWith("/Applications/Codex.app/") ||
    path.startsWith("/Applications/ChatGPT.app/") ||
    path.startsWith("/Users/") ||
    path.includes("/Codex Computer Use.app/")
  );
}

function isRelativeCodexPath(path: string): boolean {
  return path.startsWith("~/") || path.startsWith("./") || path.startsWith("../");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
