import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { CliError } from "../errors.ts";
import type { CodexPluginPolicy, CodexPluginPolicyMode, Config } from "../types/index.ts";
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
  };
}

function assertConfig(raw: unknown): asserts raw is RawConfig {
  if (!isRecord(raw)) throw new Error("config root must be a table");
  assertOptionalRecord(raw, "target", (target) => {
    assertOptionalString(target, "type");
    if (target.type !== undefined && target.type !== "ssh") {
      throw new Error('target.type must be "ssh"');
    }
    assertOptionalString(target, "host");
    assertOptionalString(target, "path");
  });
  assertOptionalRecord(raw, "include", (include) => {
    assertOptionalBoolean(include, "settings_local");
    assertOptionalBoolean(include, "mcp_config");
  });
  assertOptionalRecord(raw, "backup", (backup) => assertOptionalString(backup, "path"));
  assertOptionalRecord(raw, "providers", (providers) => {
    assertOptionalRecord(providers, "claude", (claude) => {
      assertOptionalBoolean(claude, "enabled");
      assertOptionalBoolean(claude, "settings_local");
      assertOptionalBoolean(claude, "mcp_config");
    });
    assertOptionalRecord(providers, "codex", (codex) => {
      assertOptionalBoolean(codex, "enabled");
      assertOptionalRecord(codex, "plugin_policies", (policies) => {
        for (const [pluginId, policy] of Object.entries(policies)) {
          if (!isRecord(policy))
            throw new Error(`providers.codex.plugin_policies.${pluginId} must be a table`);
          assertOptionalString(policy, "mode");
          if (
            policy.mode !== undefined &&
            !["auto", "always", "never", "preserve"].includes(policy.mode as string)
          ) {
            throw new Error(`providers.codex.plugin_policies.${pluginId}.mode is invalid`);
          }
          assertOptionalStringArray(policy, "os");
          assertOptionalStringArray(policy, "commands");
          assertOptionalBoolean(policy, "gui");
        }
      });
    });
  });
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

function assertOptionalString(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string")
    throw new Error(`${key} must be a string`);
}

function assertOptionalBoolean(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean")
    throw new Error(`${key} must be a boolean`);
}

function assertOptionalStringArray(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new Error(`${key} must be an array of strings`);
  }
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

export async function loadConfig(): Promise<Config> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = parse(content);
    assertConfig(parsed);
    return normalizeConfig(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return DEFAULT_CONFIG;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to load config at ${CONFIG_PATH}: ${detail}`);
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
