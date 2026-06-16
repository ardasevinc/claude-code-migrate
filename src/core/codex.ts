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

interface CodexConfig {
  marketplaces?: Record<string, CodexMarketplaceConfig>;
}

export interface CodexLocalMarketplaceSource {
  name: string;
  rawSource: string;
  source: string;
}

export interface CodexMarketplaceSourceRewrite {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
