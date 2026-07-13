import { getConfigDir, loadConfig } from "../config/loader.ts";
import { getEnabledProviders, resolvePushArguments } from "../core/arg-parser.ts";
import { collectFiles } from "../core/collector.ts";
import {
  executePlannedPush,
  type PlannedPush,
  type PushExecutionAdapter,
  planPush,
} from "../core/plan-push.ts";
import { preparePushObservationRequest } from "../core/push-observation-request.ts";
import { applyPushProfile } from "../core/push-profile.ts";
import { createSshPushExecutionAdapter } from "../core/push-ssh-adapter.ts";
import { testConnection } from "../core/ssh.ts";
import { createSshSession } from "../core/ssh-session.ts";
import { parseSshTarget } from "../core/ssh-target.ts";
import { checkVersionCompatibility } from "../core/version-checker.ts";
import { BlockedError, ConnectivityError, ExecutionError, UsageError } from "../errors.ts";
import { createRuntimeContext } from "../runtime/context.ts";
import type { PushOptions } from "../types/index.ts";
import { log } from "../utils/logger.ts";

export async function pushCommand(
  arg1: string | undefined,
  arg2: string | undefined,
  options: PushOptions,
): Promise<void> {
  return withPushPlan(arg1, arg2, options, async ({ planned, adapter, host }) => {
    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify(planned.plan));
        return;
      }
      log.info(`Push plan ${planned.plan.id} (${planned.plan.status})`);
      log.info(`Providers: ${planned.plan.providers.join(", ")}`);
      if (options.verbose)
        for (const action of planned.plan.actions)
          log.dim(`  ${action.phase}: ${action.operation} ${action.scope} (${action.disposition})`);
      return;
    }

    if (planned.plan.status === "blocked") throw new BlockedError("Push plan is blocked");
    log.info(`Executing push plan ${planned.plan.id}...`);
    await executePlannedPush(planned, adapter, { context: createRuntimeContext() });
    log.success(`Successfully pushed config to ${host}`);
  });
}

export interface PreparedPushCommand {
  readonly planned: PlannedPush;
  readonly adapter: PushExecutionAdapter;
  readonly host: string;
}

export async function withPushPlan<T>(
  arg1: string | undefined,
  arg2: string | undefined,
  options: PushOptions,
  consume: (prepared: PreparedPushCommand) => Promise<T>,
): Promise<T> {
  if (
    options.transport !== undefined &&
    options.transport !== "auto" &&
    options.transport !== "rsync" &&
    options.transport !== "archive"
  )
    throw new UsageError("--transport must be auto, rsync, or archive");
  if (options.json && !options.dryRun) throw new UsageError("--json currently requires --dry-run");
  const createdAt = new Date().toISOString();
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

  const selectedProfile = options.profile ? config.profiles[options.profile] : undefined;
  if (options.profile && !selectedProfile)
    throw new UsageError(`Unknown profile: ${options.profile}`);
  if (selectedProfile && targetArg)
    throw new UsageError("A profile supplies the SSH target; do not also pass a positional target");
  const host = selectedProfile?.host ?? targetArg ?? config.target.host;

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

  let files = await collectFiles({
    providers,
    includeClaudeSettingsLocal: config.providers.claude.settings_local,
    includeClaudeMcpConfig: config.providers.claude.mcp_config,
    dryRun: options.dryRun,
    quiet: options.json,
  });

  let appliedProfile: Awaited<ReturnType<typeof applyPushProfile>> | undefined;
  try {
    appliedProfile = selectedProfile
      ? await applyPushProfile({
          name: options.profile as string,
          definition: selectedProfile,
          configDir: getConfigDir(),
          providers,
          files,
        })
      : undefined;
  } catch (error) {
    throw new BlockedError(
      `Cannot apply profile ${options.profile}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (appliedProfile) files = [...appliedProfile.files];
  if (files.length === 0) throw new BlockedError("No files to push");
  const policyOverrides = {
    ...config.providers.codex.plugin_policies,
    ...(appliedProfile?.profile.pluginPolicies ?? {}),
  };

  const session = await createSshSession(host);
  const execute = async (): Promise<T> => {
    if (!options.dryRun) {
      log.info(`Testing connection to ${host}...`);
      const connected = await testConnection(host, session);
      if (!connected) {
        throw new ConnectivityError(`Cannot connect to ${host}. Check your SSH configuration.`);
      }
      log.success("Connection established");
    }

    if (!options.dryRun && providers.includes("claude") && !options.skipVersionCheck) {
      const versionCheck = await checkVersionCompatibility(host, session);
      if (versionCheck.warning) {
        log.warn(versionCheck.warning);
      }
    }

    const preparedRequest = await preparePushObservationRequest({
      host,
      files,
      providers,
      policyOverrides,
    });
    const adapter = createSshPushExecutionAdapter({
      mode: options.transport ?? "auto",
      session,
    });
    const observation = await adapter.observe(preparedRequest);
    const planned = await planPush({
      files,
      host,
      providers,
      policyOverrides,
      configuredPolicyIds: Object.keys(config.providers.codex.plugin_policies),
      profile: appliedProfile?.profile,
      observation,
      preparedRequest,
      createdAt,
    });

    return consume({ planned, adapter, host });
  };
  let primaryError: unknown;
  let failed = false;
  let result: T | undefined;
  try {
    result = await execute();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await session.close();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (failed && cleanupFailed)
    throw new ExecutionError("Push failed and SSH session cleanup also failed", {
      cause: new AggregateError([primaryError, cleanupError]),
    });
  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result as T;
}
