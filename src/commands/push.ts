import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { parseSshTarget } from "../core/ssh-target.ts";
import { checkVersionCompatibility } from "../core/version-checker.ts";
import { CliError, ConnectivityError, UsageError } from "../errors.ts";
import type { PushOptions } from "../types/index.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { log } from "../utils/logger.ts";

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
    throw new UsageError(error instanceof Error ? error.message : "Invalid arguments", {
      cause: error,
    });
  }

  const host = targetArg ?? config.target.host;

  if (host === "user@example.com") {
    throw new UsageError(
      "No target configured. Run 'ccm config --init' and edit the config, or specify a target: ccm push user@host",
    );
  }

  try {
    parseSshTarget(host);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid SSH target", {
      cause: error,
    });
  }

  const files = await collectFiles({
    providers,
    includeClaudeSettingsLocal: config.providers.claude.settings_local,
    includeClaudeMcpConfig: config.providers.claude.mcp_config,
    dryRun: options.dryRun,
  });

  if (files.length === 0) {
    throw new CliError("No files to push");
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
    throw new ConnectivityError(`Cannot connect to ${host}. Check your SSH configuration.`);
  }

  log.success("Connection established");

  if (providers.includes("claude") && !options.skipVersionCheck) {
    const versionCheck = await checkVersionCompatibility(host);
    if (versionCheck.warning) {
      log.warn(versionCheck.warning);
    }
  }

  const tempWorkspace = await mkdtemp(join(tmpdir(), "ccm-push-"));
  const tempArchive = join(tempWorkspace, "archive.tar.gz");
  let unregisterInterruptCleanup: (() => void) | undefined;

  try {
    await createArchive(files, tempArchive);
    unregisterInterruptCleanup = registerInterruptCleanup(async () => {
      await rm(tempWorkspace, { recursive: true, force: true });
    });
    await pushArchive(tempArchive, host, {
      codexPluginPolicies: config.providers.codex.plugin_policies,
    });
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
    unregisterInterruptCleanup?.();
  }
}
