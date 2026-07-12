const SAFE_ID_PART = /^[A-Za-z0-9._-]+$/;

export interface CodexMarketplaceManifestInput {
  readonly path: string;
  readonly content: string;
}

export type CodexMarketplaceAvailabilityProjection =
  | {
      readonly ok: true;
      readonly availablePluginIds: string[];
      readonly incomingMarketplaceNames: string[];
    }
  | { readonly ok: false; readonly error: string };

interface MarketplaceManifest {
  name?: unknown;
  plugins?: unknown;
}

/**
 * Projects `codex plugin list --available` after incoming marketplace manifests replace
 * the target catalogs bearing the same manifest name. The operation is atomic: any
 * malformed manifest rejects the entire projection.
 */
export function projectCodexMarketplaceAvailability(
  currentAvailablePluginIds: readonly string[],
  manifests: readonly CodexMarketplaceManifestInput[],
): CodexMarketplaceAvailabilityProjection {
  const current = new Set<string>();
  for (const id of currentAvailablePluginIds) {
    if (!isSafePluginId(id)) return { ok: false, error: `invalid current plugin ID: ${id}` };
    if (current.has(id)) return { ok: false, error: `duplicate current plugin ID: ${id}` };
    current.add(id);
  }

  const marketplaces = new Map<string, Set<string>>();
  for (const input of manifests) {
    const parsed = parseManifest(input);
    if (!parsed.ok) return parsed;

    const previous = marketplaces.get(parsed.name);
    if (previous && !setsEqual(previous, parsed.pluginNames)) {
      return {
        ok: false,
        error: `inconsistent marketplace ${parsed.name} across incoming manifests`,
      };
    }
    marketplaces.set(parsed.name, parsed.pluginNames);
  }

  for (const marketplace of marketplaces.keys()) {
    const suffix = `@${marketplace}`;
    for (const id of current) if (id.endsWith(suffix)) current.delete(id);
  }
  for (const [marketplace, pluginNames] of marketplaces) {
    for (const pluginName of pluginNames) current.add(`${pluginName}@${marketplace}`);
  }

  return {
    ok: true,
    availablePluginIds: [...current].sort(),
    incomingMarketplaceNames: [...marketplaces.keys()].sort(),
  };
}

function parseManifest(
  input: CodexMarketplaceManifestInput,
): { ok: true; name: string; pluginNames: Set<string> } | { ok: false; error: string } {
  let value: MarketplaceManifest;
  try {
    value = JSON.parse(input.content) as MarketplaceManifest;
  } catch {
    return { ok: false, error: `${input.path}: invalid JSON` };
  }
  if (!isRecord(value)) return { ok: false, error: `${input.path}: manifest must be an object` };
  if (typeof value.name !== "string" || !SAFE_ID_PART.test(value.name)) {
    return { ok: false, error: `${input.path}: invalid marketplace name` };
  }
  if (!Array.isArray(value.plugins)) {
    return { ok: false, error: `${input.path}: plugins must be an array` };
  }

  const pluginNames = new Set<string>();
  const seenPluginNames = new Set<string>();
  for (const [index, plugin] of value.plugins.entries()) {
    if (!isRecord(plugin) || typeof plugin.name !== "string" || !SAFE_ID_PART.test(plugin.name)) {
      return { ok: false, error: `${input.path}: invalid plugin name at index ${index}` };
    }
    if (seenPluginNames.has(plugin.name)) {
      return { ok: false, error: `${input.path}: duplicate plugin name: ${plugin.name}` };
    }
    seenPluginNames.add(plugin.name);
    const invalidSource = validateSource(plugin.source);
    if (invalidSource)
      return { ok: false, error: `${input.path}: ${invalidSource} at index ${index}` };
    const policy = validatePolicy(plugin.policy);
    if (!policy.ok) return { ok: false, error: `${input.path}: ${policy.error} at index ${index}` };
    if (policy.available) pluginNames.add(plugin.name);
  }
  return { ok: true, name: value.name, pluginNames };
}

function validateSource(source: unknown): string | null {
  if (typeof source === "string") return isLocalPath(source) ? null : "invalid local source path";
  if (!isRecord(source) || typeof source.source !== "string") return "unsupported plugin source";

  if (source.source === "local") {
    return typeof source.path === "string" && isLocalPath(source.path)
      ? null
      : "invalid local source path";
  }
  if (source.source === "url" || source.source === "git-subdir") {
    if (typeof source.url !== "string" || !isGitUrl(source.url)) return "invalid git source URL";
    if (
      source.source === "git-subdir" &&
      (typeof source.path !== "string" || !isSafeSubdir(source.path))
    ) {
      return "invalid git source path";
    }
    if (
      source.path !== undefined &&
      (typeof source.path !== "string" || !isSafeSubdir(source.path))
    ) {
      return "invalid git source path";
    }
    for (const key of ["ref", "sha"] as const) {
      if (source[key] !== undefined && typeof source[key] !== "string") return `invalid git ${key}`;
    }
    return null;
  }
  if (source.source === "npm") {
    if (typeof source.package !== "string" || !isNpmPackage(source.package)) {
      return "invalid npm package";
    }
    if (
      source.version !== undefined &&
      (typeof source.version !== "string" ||
        !source.version.trim() ||
        /[\\/:]/.test(source.version) ||
        source.version === "." ||
        source.version === "..")
    ) {
      return "invalid npm version";
    }
    if (source.registry !== undefined && !isHttpsRegistry(source.registry)) {
      return "invalid npm registry";
    }
    return null;
  }
  return "unsupported plugin source";
}

function validatePolicy(
  value: unknown,
): { ok: true; available: boolean } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, available: true };
  if (!isRecord(value)) return { ok: false, error: "policy must be an object" };
  const installation = value.installation ?? "AVAILABLE";
  if (!["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(String(installation))) {
    return { ok: false, error: "invalid installation policy" };
  }
  const authentication = value.authentication ?? "ON_INSTALL";
  if (!["ON_INSTALL", "ON_USE"].includes(String(authentication))) {
    return { ok: false, error: "invalid authentication policy" };
  }
  if (value.products !== undefined) {
    if (
      !Array.isArray(value.products) ||
      value.products.some(
        (product) =>
          typeof product !== "string" ||
          !["codex", "CODEX", "chatgpt", "CHATGPT", "atlas", "ATLAS"].includes(product),
      )
    ) {
      return { ok: false, error: "invalid products policy" };
    }
  }
  const products = value.products as string[] | undefined;
  return {
    ok: true,
    available:
      installation !== "NOT_AVAILABLE" &&
      (products === undefined || products.some((product) => product.toLowerCase() === "codex")),
  };
}

function isLocalPath(value: string): boolean {
  if (value === "." || value === "./") return true;
  if (!value.startsWith("./")) return false;
  return isSafeSubdir(value);
}

function isSafeSubdir(value: string): boolean {
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  return (
    Boolean(normalized) &&
    normalized.split(/[\\/]/).every((part) => part && part !== "." && part !== "..")
  );
}

function isGitUrl(value: string): boolean {
  const url = value.trim();
  return (
    /^(https?:\/\/|ssh:\/\/|file:\/\/|\/)/.test(url) ||
    /^git@[^:]+:.+/.test(url) ||
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/.test(url) ||
    (url.startsWith("./") && isSafeSubdir(url))
  );
}

function isNpmPackage(value: string): boolean {
  const pattern = "[A-Za-z0-9][A-Za-z0-9._-]*";
  return new RegExp(`^(?:@${pattern}/${pattern}|${pattern})$`).test(value.trim());
}

function isHttpsRegistry(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isSafePluginId(id: string): boolean {
  const separator = id.lastIndexOf("@");
  return (
    separator > 0 &&
    separator < id.length - 1 &&
    SAFE_ID_PART.test(id.slice(0, separator)) &&
    SAFE_ID_PART.test(id.slice(separator + 1))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
