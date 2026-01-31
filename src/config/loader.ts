import { parse } from "smol-toml";
import { CONFIG_PATH, CONFIG_DIR, DEFAULT_CONFIG_TOML } from "./schema.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { Config } from "../types/index.ts";
import { log } from "../utils/logger.ts";

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);

  if (!(await file.exists())) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = await file.text();
    const parsed = parse(content) as unknown as Config;

    return {
      target: {
        type: parsed.target?.type ?? DEFAULT_CONFIG.target.type,
        host: parsed.target?.host ?? DEFAULT_CONFIG.target.host,
        path: parsed.target?.path ?? DEFAULT_CONFIG.target.path,
      },
      include: {
        settings_local:
          parsed.include?.settings_local ?? DEFAULT_CONFIG.include.settings_local,
        mcp_config:
          parsed.include?.mcp_config ?? DEFAULT_CONFIG.include.mcp_config,
      },
      backup: {
        path: parsed.backup?.path ?? DEFAULT_CONFIG.backup.path,
      },
    };
  } catch (error) {
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
