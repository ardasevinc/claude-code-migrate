import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config/loader.ts";
import { CODEX_DIR } from "../config/providers.ts";
import { createArchive } from "../core/archiver.ts";
import { getEnabledProviders, resolvePushArguments } from "../core/arg-parser.ts";
import { collectFiles } from "../core/collector.ts";
import {
  previewPush,
  previewRemoteCodexPluginPolicy,
  pushArchive,
  testConnection,
} from "../core/ssh.ts";
import { checkVersionCompatibility } from "../core/version-checker.ts";
import type { PushOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";

export async function pushCommand(
  arg1: string | undefined,
  arg2: string | undefined,
  options: PushOptions,
): Promise<void> {
  const config = await loadConfig();
  const enabledProviders = getEnabledProviders(config);

  let providers = enabledProviders;
  let targetArg: string | undefined;

  try {
    const resolved = resolvePushArguments(arg1, arg2, enabledProviders, {
      all: options.all,
      providers: options.providers,
    });
    providers = resolved.providers;
    targetArg = resolved.target;
  } catch (error) {
    log.error(error instanceof Error ? error.message : "Invalid arguments");
    return;
  }

  const host = targetArg ?? config.target.host;

  if (host === "user@example.com") {
    log.error(
      "No target configured. Run 'ccm config --init' and edit the config, or specify a target: ccm push user@host",
    );
    return;
  }

  const files = await collectFiles({
    providers,
    includeClaudeSettingsLocal: config.providers.claude.settings_local,
    includeClaudeMcpConfig: config.providers.claude.mcp_config,
    dryRun: options.dryRun,
  });

  if (files.length === 0) {
    log.error("No files to push");
    return;
  }

  if (options.dryRun) {
    await previewPush(files, host, { verbose: options.verbose ?? false });
    if (providers.includes("codex")) {
      const codexConfigPath = join(CODEX_DIR, "config.toml");
      const rawCodexConfig = await readFile(codexConfigPath, "utf8").catch(() => "");
      if (rawCodexConfig.trim()) {
        await previewRemoteCodexPluginPolicy(
          host,
          rawCodexConfig,
          config.providers.codex.plugin_policies,
        );
      }
    }
    return;
  }

  log.info(`Testing connection to ${host}...`);
  const connected = await testConnection(host);

  if (!connected) {
    log.error(`Cannot connect to ${host}. Check your SSH configuration.`);
    return;
  }

  log.success("Connection established");

  if (providers.includes("claude") && !options.skipVersionCheck) {
    const versionCheck = await checkVersionCompatibility(host);
    if (versionCheck.warning) {
      log.warn(versionCheck.warning);
    }
  }

  const tempArchive = join(tmpdir(), `ccm-push-${Date.now()}.tar.gz`);

  try {
    await createArchive(files, tempArchive);
    const success = await pushArchive(tempArchive, host, {
      codexPluginPolicies: config.providers.codex.plugin_policies,
    });

    if (!success) {
      process.exit(1);
    }
  } finally {
    await runCommand(`rm -f ${shellQuote(tempArchive)}`, { quiet: true, nothrow: true });
  }
}
