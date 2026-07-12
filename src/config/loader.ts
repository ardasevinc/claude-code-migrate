import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import { assertCodexProfilePatchAllowed, decodeJsonPointer } from "../core/structured-patch.ts";
import { CliError } from "../errors.ts";
import type {
  CodexPluginPolicy,
  CodexPluginPolicyMode,
  Config,
  HostProfile,
  StructuredPatch,
  StructuredValue,
} from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_CONFIG_TOML } from "./schema.ts";

type RawConfig = {
  target?: {
    type?: string;
    host?: string;
    path?: string;
  };
  include?: {
    settings_local?: boolean;
    mcp_config?: boolean;
  };
  providers?: {
    claude?: {
      enabled?: boolean;
      settings_local?: boolean;
      mcp_config?: boolean;
    };
    codex?: {
      enabled?: boolean;
      plugin_policies?: Record<
        string,
        {
          mode?: string;
          os?: string[];
          commands?: string[];
          gui?: boolean;
        }
      >;
    };
  };
  backup?: {
    path?: string;
  };
  profiles?: Record<string, RawHostProfile>;
};

type RawStructuredPatch = {
  unset?: string[];
  set?: Record<string, StructuredValue>;
};

type RawHostProfile = {
  host?: string;
  claude_md?: string;
  agents_md?: string;
  claude?: { settings?: RawStructuredPatch };
  codex?: {
    config?: RawStructuredPatch;
    plugin_policies?: Record<string, RawCodexPluginPolicy>;
  };
};

type RawCodexPluginPolicy = {
  mode?: string;
  os?: string[];
  commands?: string[];
  gui?: boolean;
};

function normalizeConfig(raw: RawConfig): Config {
  const targetType = raw.target?.type === "ssh" ? "ssh" : DEFAULT_CONFIG.target.type;

  return {
    target: {
      type: targetType,
      host: raw.target?.host ?? DEFAULT_CONFIG.target.host,
    },
    providers: {
      claude: {
        enabled: raw.providers?.claude?.enabled ?? DEFAULT_CONFIG.providers.claude.enabled,
        settings_local:
          raw.providers?.claude?.settings_local ??
          raw.include?.settings_local ??
          DEFAULT_CONFIG.providers.claude.settings_local,
        mcp_config:
          raw.providers?.claude?.mcp_config ??
          raw.include?.mcp_config ??
          DEFAULT_CONFIG.providers.claude.mcp_config,
      },
      codex: {
        enabled: raw.providers?.codex?.enabled ?? DEFAULT_CONFIG.providers.codex.enabled,
        plugin_policies: normalizeCodexPluginPolicies(raw.providers?.codex?.plugin_policies),
      },
    },
    backup: {
      path: raw.backup?.path ?? DEFAULT_CONFIG.backup.path,
    },
    profiles: normalizeProfiles(raw.profiles),
  };
}

function assertConfig(raw: unknown): asserts raw is RawConfig {
  if (!isRecord(raw)) throw new Error("config root must be a table");
  assertKnownKeys(raw, "config", ["target", "include", "providers", "backup", "profiles"]);
  assertOptionalRecord(raw, "target", (target) => {
    assertKnownKeys(target, "target", ["type", "host", "path"]);
    assertOptionalString(target, "type", "target.type");
    if (target.type !== undefined && target.type !== "ssh") {
      throw new Error('target.type must be "ssh"');
    }
    assertOptionalNonemptyString(target, "host", "target.host");
    assertOptionalNonemptyString(target, "path", "target.path");
  });
  assertOptionalRecord(raw, "include", (include) => {
    assertKnownKeys(include, "include", ["settings_local", "mcp_config"]);
    assertOptionalBoolean(include, "settings_local", "include.settings_local");
    assertOptionalBoolean(include, "mcp_config", "include.mcp_config");
  });
  assertOptionalRecord(raw, "backup", (backup) => {
    assertKnownKeys(backup, "backup", ["path"]);
    assertOptionalNonemptyString(backup, "path", "backup.path");
  });
  assertOptionalRecord(raw, "providers", (providers) => {
    assertKnownKeys(providers, "providers", ["claude", "codex"]);
    assertOptionalRecord(providers, "claude", (claude) => {
      assertKnownKeys(claude, "providers.claude", ["enabled", "settings_local", "mcp_config"]);
      assertOptionalBoolean(claude, "enabled", "providers.claude.enabled");
      assertOptionalBoolean(claude, "settings_local", "providers.claude.settings_local");
      assertOptionalBoolean(claude, "mcp_config", "providers.claude.mcp_config");
    });
    assertOptionalRecord(providers, "codex", (codex) => {
      assertKnownKeys(codex, "providers.codex", ["enabled", "plugin_policies"]);
      assertOptionalBoolean(codex, "enabled", "providers.codex.enabled");
      assertOptionalRecord(codex, "plugin_policies", (policies) => {
        for (const [pluginId, policy] of Object.entries(policies)) {
          if (!pluginId.trim()) throw new Error("Codex plugin policy ID must not be empty");
          if (FORBIDDEN_OBJECT_KEYS.has(pluginId)) {
            throw new Error(`Codex plugin policy ID is forbidden: ${pluginId}`);
          }
          if (!isRecord(policy))
            throw new Error(`providers.codex.plugin_policies.${pluginId} must be a table`);
          const policyPath = `providers.codex.plugin_policies.${pluginId}`;
          assertKnownKeys(policy, policyPath, ["mode", "os", "commands", "gui"]);
          assertOptionalString(policy, "mode", `${policyPath}.mode`);
          if (
            policy.mode !== undefined &&
            !["auto", "always", "never", "preserve"].includes(policy.mode as string)
          ) {
            throw new Error(`providers.codex.plugin_policies.${pluginId}.mode is invalid`);
          }
          assertOptionalStringArray(policy, "os", `${policyPath}.os`, [
            "darwin",
            "linux",
            "windows",
          ]);
          assertOptionalStringArray(policy, "commands", `${policyPath}.commands`);
          assertOptionalBoolean(policy, "gui", `${policyPath}.gui`);
        }
      });
    });
  });
  assertOptionalRecord(raw, "profiles", (profiles) => {
    for (const [name, profile] of Object.entries(profiles)) {
      if (!isSafeProfileName(name)) throw new Error(`profiles.${name} is not a safe profile name`);
      if (!isRecord(profile)) throw new Error(`profiles.${name} must be a table`);
      const profilePath = `profiles.${name}`;
      assertKnownKeys(profile, profilePath, ["host", "claude_md", "agents_md", "claude", "codex"]);
      assertRequiredNonemptyString(profile, "host", `${profilePath}.host`);
      assertOptionalNonemptyString(profile, "claude_md", `${profilePath}.claude_md`);
      assertOptionalNonemptyString(profile, "agents_md", `${profilePath}.agents_md`);
      assertOptionalRecord(profile, "claude", (claude) => {
        assertKnownKeys(claude, `${profilePath}.claude`, ["settings"]);
        assertOptionalStructuredPatch(claude, "settings", `${profilePath}.claude.settings`);
      });
      assertOptionalRecord(profile, "codex", (codex) => {
        assertKnownKeys(codex, `${profilePath}.codex`, ["config", "plugin_policies"]);
        assertOptionalStructuredPatch(codex, "config", `${profilePath}.codex.config`);
        if (isRecord(codex.config)) {
          assertCodexProfilePatchAllowed(
            normalizeStructuredPatch(codex.config as RawStructuredPatch) as StructuredPatch,
          );
        }
        assertOptionalPluginPolicies(
          codex,
          "plugin_policies",
          `${profilePath}.codex.plugin_policies`,
        );
      });
    }
  });
}

const SAFE_PROFILE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isSafeProfileName(value: string): boolean {
  return value.length <= 64 && SAFE_PROFILE_NAME.test(value) && !FORBIDDEN_OBJECT_KEYS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalRecord(
  record: Record<string, unknown>,
  key: string,
  validate: (value: Record<string, unknown>) => void,
): void {
  if (record[key] === undefined) return;
  if (!isRecord(record[key])) throw new Error(`${key} must be a table`);
  validate(record[key]);
}

function assertOptionalString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string")
    throw new Error(`${path} must be a string`);
}

function assertOptionalNonemptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  assertOptionalString(record, key, path);
  if (typeof record[key] === "string" && !record[key].trim()) {
    throw new Error(`${path} must not be empty`);
  }
}

function assertRequiredNonemptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] === undefined) throw new Error(`${path} is required`);
  assertOptionalNonemptyString(record, key, path);
}

function assertOptionalBoolean(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean")
    throw new Error(`${path} must be a boolean`);
}

function assertOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed?: string[],
): void {
  const value = record[key];
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.some(
        (item) =>
          typeof item !== "string" ||
          !item.trim() ||
          (allowed !== undefined && !allowed.includes(item)),
      ))
  ) {
    const constraint = allowed ? ` containing only ${allowed.join(", ")}` : " of nonempty strings";
    throw new Error(`${path} must be an array${constraint}`);
  }
}

function assertKnownKeys(
  record: Record<string, unknown>,
  path: string,
  allowedKeys: string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not a recognized setting`);
}

function assertOptionalStructuredPatch(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  assertOptionalRecord(record, key, (patch) => {
    assertKnownKeys(patch, path, ["unset", "set"]);
    assertOptionalStringArray(patch, "unset", `${path}.unset`);
    if (Array.isArray(patch.unset)) {
      for (const pointer of patch.unset) {
        if (pointer === "") throw new Error(`${path}.unset must not contain the root pointer`);
        decodeJsonPointer(pointer as string);
      }
    }
    assertOptionalRecord(patch, "set", (set) => assertStructuredValue(set, `${path}.set`));
  });
}

function assertStructuredValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return;
  }
  if (typeof value === "bigint" || value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertStructuredValue(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) throw new Error(`${path} contains an unsupported value`);
  for (const [childKey, child] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(childKey)) {
      throw new Error(`${path}.${childKey} is not allowed`);
    }
    assertStructuredValue(child, `${path}.${childKey}`);
  }
}

function assertOptionalPluginPolicies(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  assertOptionalRecord(record, key, (policies) => {
    for (const [pluginId, policy] of Object.entries(policies)) {
      if (!pluginId.trim()) throw new Error(`${path} plugin ID must not be empty`);
      if (FORBIDDEN_OBJECT_KEYS.has(pluginId)) {
        throw new Error(`${path} plugin ID is forbidden: ${pluginId}`);
      }
      if (!isRecord(policy)) throw new Error(`${path}.${pluginId} must be a table`);
      assertCodexPluginPolicy(policy, `${path}.${pluginId}`);
    }
  });
}

function assertCodexPluginPolicy(policy: Record<string, unknown>, path: string): void {
  assertKnownKeys(policy, path, ["mode", "os", "commands", "gui"]);
  assertOptionalString(policy, "mode", `${path}.mode`);
  if (
    policy.mode !== undefined &&
    !["auto", "always", "never", "preserve"].includes(policy.mode as string)
  ) {
    throw new Error(`${path}.mode is invalid`);
  }
  assertOptionalStringArray(policy, "os", `${path}.os`, ["darwin", "linux", "windows"]);
  assertOptionalStringArray(policy, "commands", `${path}.commands`);
  assertOptionalBoolean(policy, "gui", `${path}.gui`);
}

function normalizeCodexPluginPolicies(
  rawPolicies: Record<string, RawCodexPluginPolicy> | undefined,
): Record<string, CodexPluginPolicy> {
  const policies: Record<string, CodexPluginPolicy> = {};
  if (!rawPolicies || typeof rawPolicies !== "object") {
    return policies;
  }

  for (const [pluginId, rawPolicy] of Object.entries(rawPolicies)) {
    if (!rawPolicy || typeof rawPolicy !== "object") {
      continue;
    }

    const mode = normalizeCodexPluginPolicyMode(rawPolicy.mode);
    policies[pluginId] = {
      mode,
      os: normalizeStringArray(rawPolicy.os),
      commands: normalizeStringArray(rawPolicy.commands),
      gui: typeof rawPolicy.gui === "boolean" ? rawPolicy.gui : undefined,
    };
  }

  return policies;
}

function normalizeStructuredPatch(
  raw: RawStructuredPatch | undefined,
): StructuredPatch | undefined {
  if (!raw) return undefined;
  return {
    unset: [...(raw.unset ?? [])],
    set: { ...(raw.set ?? {}) },
  };
}

function normalizeProfiles(
  raw: Record<string, RawHostProfile> | undefined,
): Record<string, HostProfile> {
  const profiles: Record<string, HostProfile> = {};
  for (const [name, profile] of Object.entries(raw ?? {})) {
    profiles[name] = {
      host: profile.host as string,
      claude_md: profile.claude_md,
      agents_md: profile.agents_md,
      claude: profile.claude
        ? { settings: normalizeStructuredPatch(profile.claude.settings) }
        : undefined,
      codex: profile.codex
        ? {
            config: normalizeStructuredPatch(profile.codex.config),
            plugin_policies: normalizeCodexPluginPolicies(profile.codex.plugin_policies),
          }
        : undefined,
    };
  }
  return profiles;
}

function normalizeCodexPluginPolicyMode(value: string | undefined): CodexPluginPolicyMode {
  return value === "always" || value === "never" || value === "preserve" ? value : "auto";
}

function normalizeStringArray(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.filter((item) => typeof item === "string" && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

export async function loadConfig(configPath = CONFIG_PATH): Promise<Config> {
  try {
    const content = await readFile(configPath, "utf8");
    const parsed: unknown = parse(content);
    assertConfig(parsed);
    return normalizeConfig(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return normalizeConfig({});
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to load config at ${configPath}: ${detail}`, 3, { cause: error });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function initConfig(): Promise<boolean> {
  if (await exists(CONFIG_PATH)) {
    log.warn(`Config already exists at ${CONFIG_PATH}`);
    return false;
  }

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, DEFAULT_CONFIG_TOML, "utf8");
  log.success(`Created config at ${CONFIG_PATH}`);
  return true;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfigDir(configPath = CONFIG_PATH): string {
  return dirname(configPath);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
