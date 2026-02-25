import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { createArchive } from "../core/archiver.ts";
import { collectFiles } from "../core/collector.ts";
import { previewPush, pushArchive, testConnection } from "../core/ssh.ts";
import { checkVersionCompatibility } from "../core/version-checker.ts";
import type { PushOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";

export async function pushCommand(
  targetArg: string | undefined,
  options: PushOptions,
): Promise<void> {
  const config = await loadConfig();

  const host = targetArg ?? config.target.host;
  const remotePath = config.target.path;

  if (host === "user@example.com") {
    log.error(
      "No target configured. Run 'ccm config --init' and edit the config, or specify a target: ccm push user@host",
    );
    return;
  }

  const files = await collectFiles({
    includeSettingsLocal: config.include.settings_local,
    includeMcpConfig: config.include.mcp_config,
    dryRun: options.dryRun,
  });

  if (files.length === 0) {
    log.error("No files to push");
    return;
  }

  if (options.dryRun) {
    await previewPush(files, host, remotePath);
    return;
  }

  log.info(`Testing connection to ${host}...`);
  const connected = await testConnection(host);

  if (!connected) {
    log.error(`Cannot connect to ${host}. Check your SSH configuration.`);
    return;
  }

  log.success("Connection established");

  if (!options.skipVersionCheck) {
    const versionCheck = await checkVersionCompatibility(host);
    if (versionCheck.warning) {
      log.warn(versionCheck.warning);
    }
  }

  const tempArchive = join(tmpdir(), `ccm-push-${Date.now()}.tar.gz`);

  try {
    await createArchive(files, tempArchive);
    const success = await pushArchive(tempArchive, host, remotePath);
    if (!success) {
      process.exit(1);
    }
  } finally {
    await Bun.$`rm -f ${tempArchive}`.quiet().nothrow();
  }
}
