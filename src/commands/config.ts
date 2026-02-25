import { getConfigPath, initConfig, loadConfig } from "../config/loader.ts";
import { log } from "../utils/logger.ts";

export async function configCommand(options: { init?: boolean; path?: boolean }): Promise<void> {
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
  console.log(`  Target: ${config.target.type}://${config.target.host}`);
  console.log(`  Backup path: ${config.backup.path}`);
  console.log();
  console.log("  Providers:");
  console.log(`    claude.enabled: ${config.providers.claude.enabled}`);
  console.log(`    claude.settings_local: ${config.providers.claude.settings_local}`);
  console.log(`    claude.mcp_config: ${config.providers.claude.mcp_config}`);
  console.log(`    codex.enabled: ${config.providers.codex.enabled}`);
  console.log();
  log.dim(`Config file: ${getConfigPath()}`);
}
