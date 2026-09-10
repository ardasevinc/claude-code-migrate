import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable } from "smol-toml";
import type { CodexPluginPolicy } from "../types/index.ts";
import { isCodexManagedMarketplace } from "./codex.ts";
import { applyCodexPluginPolicies, upsertCodexPluginEnabled } from "./codex-plugin-policy.ts";
import type { PushTargetObservation } from "./push-observation.ts";

/** Adapt portable plugin requests to the catalogs the target actually exposes. */
export function adaptCodexPushPlugins(
  rawConfig: string,
  target: PushTargetObservation,
  overrides: Record<string, CodexPluginPolicy>,
) {
  const remoteBytes = target.facts.captures.get("codex-config");
  const remoteRaw = remoteBytes ? Buffer.from(remoteBytes).toString("utf8") : undefined;
  const config = parse(rawConfig);
  const remote = remoteRaw ? parse(remoteRaw) : {};
  const before = stringify(config);
  const listed = target.facts.codexPluginList;
  const known = new Set(listed.status === "ok" ? [...listed.installed, ...listed.available] : []);
  const knownMarkets = new Set([...known].map((id) => id.slice(id.lastIndexOf("@") + 1)));
  const marketplaces = (config.marketplaces ?? {}) as TomlTable;
  const remoteMarkets = (remote.marketplaces ?? {}) as TomlTable;

  // Preserve working target registrations, never repoint a runtime to a copied snapshot.
  for (const name of new Set([...Object.keys(marketplaces), ...Object.keys(remoteMarkets)])) {
    if (!isCodexManagedMarketplace(name)) continue;
    if (remoteMarkets[name] && knownMarkets.has(name)) marketplaces[name] = remoteMarkets[name];
    else delete marketplaces[name];
  }
  if (Object.keys(marketplaces).length) config.marketplaces = marketplaces;
  else delete config.marketplaces;

  const targetId = (id: string) => {
    const alias = id.replace(/@openai-curated$/, "@openai-curated-remote");
    return !known.has(id) && known.has(alias) ? alias : id;
  };
  const sourceIds = new Map<string, string>();
  const plugins = (config.plugins ?? {}) as TomlTable;
  for (const id of Object.keys(plugins)) {
    const value = plugins[id];
    if (value === undefined) continue;
    const alias = targetId(id);
    if (alias === id) continue;
    if (plugins[alias] && !isDeepStrictEqual(plugins[alias], plugins[id])) {
      throw new Error(`Conflicting plugin settings for ${id} and ${alias}`);
    }
    plugins[alias] = value;
    delete plugins[id];
    sourceIds.set(alias, id);
  }
  const policies: Record<string, CodexPluginPolicy> = {};
  for (const [id, policy] of Object.entries(overrides)) {
    const alias = targetId(id);
    if (policies[alias] && !isDeepStrictEqual(policies[alias], policy)) {
      throw new Error(`Conflicting plugin policies for ${alias}`);
    }
    policies[alias] = policy;
    if (alias !== id) sourceIds.set(alias, id);
  }
  const normalized = stringify(config);
  const applied = applyCodexPluginPolicies(
    normalized === before ? rawConfig : normalized,
    target.capabilities,
    policies,
    { preserveConfigRaw: remoteRaw },
  );
  for (const decision of applied.decisions) {
    const sourceId = sourceIds.get(decision.pluginId);
    if (sourceId) decision.sourcePluginId = sourceId;
    if (
      listed.status !== "ok" ||
      !decision.enabled ||
      decision.action === "preserve" ||
      policies[decision.pluginId]?.mode === "always" ||
      known.has(decision.pluginId) ||
      !isCodexManagedMarketplace(decision.pluginId.split("@").at(-1) ?? "")
    )
      continue;
    decision.enabled = false;
    decision.action = "disable";
    decision.reason = "runtime plugin is unavailable on the target";
    applied.content = upsertCodexPluginEnabled(applied.content, decision.pluginId, false);
  }
  return applied;
}
