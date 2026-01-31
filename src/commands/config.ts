import { loadConfig, initConfig, getConfigPath } from "../config/loader.ts";
import { log } from "../utils/logger.ts";

export async function configCommand(options: {
  init?: boolean;
  path?: boolean;
}): Promise<void> {
  if (options.path) {
    console.log(getConfigPath());
    return;
  }

  if (options.init) {
    await initConfig();
    return;
  }

  const config = await loadConfig();

  log.info("Current configuration:");
  console.log();
  console.log(`  Target: ${config.target.type}://${config.target.host}${config.target.path}`);
  console.log(`  Backup path: ${config.backup.path}`);
  console.log();
  console.log("  Include options:");
  console.log(`    settings.local.json: ${config.include.settings_local}`);
  console.log(`    ~/.claude.json (MCP): ${config.include.mcp_config}`);
  console.log();
  log.dim(`Config file: ${getConfigPath()}`);
}
