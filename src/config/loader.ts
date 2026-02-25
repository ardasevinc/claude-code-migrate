import { parse } from "smol-toml";
import type { Config } from "../types/index.ts";
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
    };
  };
  backup?: {
    path?: string;
  };
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
      },
    },
    backup: {
      path: raw.backup?.path ?? DEFAULT_CONFIG.backup.path,
    },
  };
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);

  if (!(await file.exists())) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = await file.text();
    const parsed = parse(content) as unknown as RawConfig;
    return normalizeConfig(parsed);
  } catch {
    log.warn(`Failed to parse config at ${CONFIG_PATH}, using defaults`);
    return DEFAULT_CONFIG;
  }
}

export async function initConfig(): Promise<boolean> {
  const file = Bun.file(CONFIG_PATH);

  if (await file.exists()) {
    log.warn(`Config already exists at ${CONFIG_PATH}`);
    return false;
  }

  await Bun.$`mkdir -p ${CONFIG_DIR}`;
  await Bun.write(CONFIG_PATH, DEFAULT_CONFIG_TOML);
  log.success(`Created config at ${CONFIG_PATH}`);
  return true;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
