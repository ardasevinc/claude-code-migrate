import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { collectionPathsForHome } from "../config/providers.ts";
import type { CodexPluginPolicy } from "../types/index.ts";
import {
  adaptCodexConfigForHost,
  getCodexLocalMarketplaceSources,
  rewriteCodexMarketplaceSources,
} from "./codex.ts";
import { adaptCodexHooksForHost } from "./codex-hooks.ts";
import {
  applyCodexPluginPolicies,
  type CodexPluginPolicyDecision,
  codexPluginPolicyCommandNames,
  mergeCodexPluginPolicies,
} from "./codex-plugin-policy.ts";
import { getCodexMcpCommandPathCandidates, normalizeCodexMcpCommandPaths } from "./mcp.ts";
import type { PushObservationQueries, PushTargetObservation } from "./push-observation.ts";
import { mergeClaudeMcpStrict, stripAllCodexHookTrust } from "./restore-transforms.ts";

interface HookFile {
  hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
}
interface HostConfig {
  notify?: string[];
  mcp_servers?: Record<string, { command?: string }>;
  mcpServers?: Record<string, { command?: string }>;
}
const PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;

export interface PushTransformInputs {
  readonly claudeMcp?: Uint8Array;
  readonly codexConfig?: Uint8Array;
  readonly codexHooks?: Uint8Array;
}

export interface PushTransformResult extends PushTransformInputs {
  readonly warnings: readonly string[];
  readonly pluginDecisions: readonly CodexPluginPolicyDecision[];
  readonly pluginDesires: readonly string[];
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

export function derivePushObservationQueries(
  inputs: PushTransformInputs,
  policyOverrides: Record<string, CodexPluginPolicy> = {},
): PushObservationQueries {
  const paths = new Set<string>();
  const commands = new Set(
    codexPluginPolicyCommandNames(mergeCodexPluginPolicies(policyOverrides)),
  );
  const markets = new Set<string>();
  const captures: Array<"claude-mcp" | "codex-config"> = [];
  if (inputs.claudeMcp) captures.push("claude-mcp");
  if (inputs.codexConfig) {
    captures.push("codex-config");
    const raw = text(inputs.codexConfig);
    for (const source of getCodexLocalMarketplaceSources(raw, "/")) markets.add(source.name);
    for (const candidate of getCodexMcpCommandPathCandidates(raw))
      commands.add(candidate.binaryName);
    const config = parse(raw) as unknown as HostConfig;
    if (
      typeof config.notify?.[0] === "string" &&
      (config.notify[0].startsWith("/") || config.notify[0].startsWith("~/"))
    )
      paths.add(config.notify[0]);
    for (const server of Object.values(config.mcp_servers ?? config.mcpServers ?? {}))
      if (
        typeof server.command === "string" &&
        (server.command.startsWith("/") || server.command.startsWith("~/"))
      )
        paths.add(server.command);
  }
  if (inputs.codexHooks) {
    const parsed = JSON.parse(text(inputs.codexHooks)) as HookFile;
    for (const groups of Object.values(parsed.hooks ?? {}))
      for (const group of groups)
        for (const hook of group.hooks ?? [])
          if (
            hook.type === "command" &&
            typeof hook.command === "string" &&
            PATH_PATTERN.test(hook.command)
          )
            commands.add(basename(hook.command));
  }
  return {
    pathExistence: [...paths].sort(),
    commandNames: [...commands].sort(),
    captureIds: captures.sort(),
    marketplaceNames: [...markets].sort(),
    sharedSkillNames: true,
    codexPluginList: inputs.codexConfig !== undefined,
  };
}

function command(facts: PushTargetObservation["facts"], name: string): string | null {
  if (!facts.commandPaths.has(name)) throw new Error(`Missing observed command fact: ${name}`);
  return facts.commandPaths.get(name) ?? null;
}

function exists(facts: PushTargetObservation["facts"], path: string): boolean {
  const value = facts.pathExistence.get(path);
  if (value === undefined) throw new Error(`Missing observed path fact: ${path}`);
  return value;
}

export async function transformPushInputs(
  inputs: PushTransformInputs,
  target: PushTargetObservation,
  policyOverrides: Record<string, CodexPluginPolicy> = {},
): Promise<PushTransformResult> {
  const paths = collectionPathsForHome(target.facts.home);
  const remoteMcp = target.facts.captures.get("claude-mcp") ?? null;
  const claudeMcp = inputs.claudeMcp
    ? mergeClaudeMcpStrict(
        inputs.claudeMcp,
        remoteMcp
          ? { exists: true, bytes: remoteMcp, fingerprint: target.pushStateFingerprint }
          : { exists: false, fingerprint: target.pushStateFingerprint },
      )
    : undefined;
  let config = inputs.codexConfig ? stripAllCodexHookTrust(text(inputs.codexConfig)) : undefined;
  let hooks = inputs.codexHooks ? text(inputs.codexHooks) : undefined;
  const warnings: string[] = [];
  let pluginDecisions: readonly CodexPluginPolicyDecision[] = [];
  if (config !== undefined) {
    const normalized = await normalizeCodexMcpCommandPaths(config, async (name) =>
      command(target.facts, name),
    );
    config = normalized.content;
    warnings.push(...normalized.warnings);
    const marketplaces = await rewriteCodexMarketplaceSources(config, async (source) =>
      target.facts.marketplacePayloads.get(source.name)
        ? join(paths.codexDir, ".ccm", "marketplaces", source.name)
        : null,
    );
    config = marketplaces.content;
    warnings.push(...marketplaces.warnings);
    if (hooks !== undefined) {
      const adapted = await adaptCodexHooksForHost(
        hooks,
        config,
        join(paths.codexDir, "hooks.json"),
        async (name) => command(target.facts, name),
        { preserveVerifiedTrust: false },
      );
      hooks = adapted.hooksContent;
      config = adapted.configContent;
      warnings.push(...adapted.warnings);
    }
    const host = await adaptCodexConfigForHost(
      config,
      async (path) =>
        path.startsWith("./") || path.startsWith("../") ? false : exists(target.facts, path),
      { removeUnresolvedRelativePaths: true },
    );
    config = host.content;
    warnings.push(...host.warnings);
    const remoteConfig = target.facts.captures.get("codex-config");
    const applied = applyCodexPluginPolicies(config, target.capabilities, policyOverrides, {
      preserveConfigRaw: remoteConfig ? text(remoteConfig) : undefined,
    });
    config = applied.content;
    pluginDecisions = applied.decisions;
    warnings.push(...applied.warnings);
  }
  return {
    claudeMcp,
    codexConfig: config === undefined ? undefined : Buffer.from(config),
    codexHooks: hooks === undefined ? undefined : Buffer.from(hooks),
    warnings,
    pluginDecisions,
    pluginDesires: pluginDecisions
      .filter((decision) => decision.enabled && decision.action !== "preserve")
      .map((decision) => decision.pluginId),
  };
}
