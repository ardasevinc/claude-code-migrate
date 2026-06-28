import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
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
  if (!(await exists(CONFIG_PATH))) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const parsed = parse(content) as unknown as RawConfig;
    return normalizeConfig(parsed);
  } catch {
    log.warn(`Failed to parse config at ${CONFIG_PATH}, using defaults`);
    return DEFAULT_CONFIG;
  }
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
