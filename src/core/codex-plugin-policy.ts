import { parse } from "smol-toml";
import type { CodexPluginPolicy } from "../types/index.ts";

export interface HostCapabilities {
  os: string;
  arch: string;
  gui: boolean;
  commands: string[];
}

export interface CodexPluginPolicyDecision {
  pluginId: string;
  enabled: boolean;
  policy: CodexPluginPolicy;
  action: "enable" | "disable" | "preserve";
  reason: string;
}

export interface CodexPluginPolicyApplication {
  content: string;
  decisions: CodexPluginPolicyDecision[];
  changes: string[];
  warnings: string[];
}

interface CodexConfigWithPlugins {
  plugins?: Record<string, { enabled?: boolean }>;
}

const DEFAULT_CODEX_PLUGIN_POLICIES: Record<string, CodexPluginPolicy> = {
  "build-ios-apps@openai-curated": {
    mode: "auto",
    os: ["darwin"],
    commands: ["xcodebuild"],
  },
  "build-macos-apps@openai-curated": {
    mode: "auto",
    os: ["darwin"],
    commands: ["xcodebuild"],
  },
  "test-android-apps@openai-curated": {
    mode: "auto",
    commands: ["adb"],
  },
  "computer-use@openai-bundled": {
    mode: "auto",
    os: ["darwin"],
    gui: true,
  },
};

export function mergeCodexPluginPolicies(
  overrides: Record<string, CodexPluginPolicy> = {},
): Record<string, CodexPluginPolicy> {
  return {
    ...DEFAULT_CODEX_PLUGIN_POLICIES,
    ...overrides,
  };
}

export function codexPluginPolicyCommandNames(
  policies: Record<string, CodexPluginPolicy>,
): string[] {
  return Array.from(
    new Set(
      Object.values(policies)
        .flatMap((policy) => policy.commands ?? [])
        .filter((command) => command.trim().length > 0),
    ),
  ).sort();
}

export function applyCodexPluginPolicies(
  rawConfig: string,
  capabilities: HostCapabilities,
  policyOverrides: Record<string, CodexPluginPolicy> = {},
  options: { preserveConfigRaw?: string } = {},
): CodexPluginPolicyApplication {
  const parsed = parse(rawConfig) as unknown as CodexConfigWithPlugins;
  const preserveParsed = options.preserveConfigRaw
    ? (parse(options.preserveConfigRaw) as unknown as CodexConfigWithPlugins)
    : undefined;
  const plugins = parsed.plugins ?? {};
  const preservedPlugins = preserveParsed?.plugins ?? {};
  const policies = mergeCodexPluginPolicies(policyOverrides);
  const decisions: CodexPluginPolicyDecision[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  let content = rawConfig;

  for (const [pluginId, plugin] of Object.entries(plugins)) {
    const policy = policies[pluginId] ?? { mode: "always" };
    if (policy.mode === "preserve") {
      const preservedEnabled = preservedPlugins[pluginId]?.enabled;
      if (typeof preservedEnabled !== "boolean") {
        decisions.push(evaluateCodexPluginPolicy(pluginId, policy, capabilities));
        continue;
      }

      decisions.push({
        pluginId,
        enabled: preservedEnabled,
        policy,
        action: "preserve",
        reason: "policy preserves target value",
      });

      const nextContent = upsertCodexPluginEnabled(content, pluginId, preservedEnabled);
      if (nextContent === content) {
        continue;
      }

      content = nextContent;
      changes.push(`${pluginId}: preserved target enabled = ${preservedEnabled}`);
      continue;
    }

    if (plugin.enabled !== true) {
      continue;
    }

    const decision = evaluateCodexPluginPolicy(pluginId, policy, capabilities);
    decisions.push(decision);

    if (decision.action === "preserve") {
      continue;
    }

    if (plugin.enabled === decision.enabled) {
      continue;
    }

    const nextContent = upsertCodexPluginEnabled(content, pluginId, decision.enabled);
    if (nextContent === content) {
      warnings.push(`${pluginId}: could not set enabled = ${decision.enabled}`);
      continue;
    }

    content = nextContent;
    changes.push(`${pluginId}: enabled -> ${decision.enabled} (${decision.reason})`);
  }

  for (const [pluginId, policy] of Object.entries(policies)) {
    if (policy.mode !== "preserve" || pluginId in plugins) {
      continue;
    }

    const preservedEnabled = preservedPlugins[pluginId]?.enabled;
    if (typeof preservedEnabled !== "boolean") {
      continue;
    }

    decisions.push({
      pluginId,
      enabled: preservedEnabled,
      policy,
      action: "preserve",
      reason: "policy preserves target value",
    });
    content = upsertCodexPluginEnabled(content, pluginId, preservedEnabled);
    changes.push(`${pluginId}: preserved target enabled = ${preservedEnabled}`);
  }

  return { content, decisions, changes, warnings };
}

export function evaluateCodexPluginPolicy(
  pluginId: string,
  policy: CodexPluginPolicy,
  capabilities: HostCapabilities,
): CodexPluginPolicyDecision {
  if (policy.mode === "preserve") {
    return {
      pluginId,
      enabled: true,
      policy,
      action: "preserve",
      reason: "policy preserves target value",
    };
  }

  if (policy.mode === "never") {
    return { pluginId, enabled: false, policy, action: "disable", reason: "policy mode is never" };
  }

  if (policy.mode === "always") {
    return { pluginId, enabled: true, policy, action: "enable", reason: "policy mode is always" };
  }

  const requiredOs = policy.os?.map((os) => os.toLowerCase());
  if (requiredOs && !requiredOs.includes(capabilities.os.toLowerCase())) {
    return {
      pluginId,
      enabled: false,
      policy,
      action: "disable",
      reason: `host os ${capabilities.os} not in ${requiredOs.join(",")}`,
    };
  }

  if (typeof policy.gui === "boolean" && policy.gui !== capabilities.gui) {
    return {
      pluginId,
      enabled: false,
      policy,
      action: "disable",
      reason: `host gui=${capabilities.gui}`,
    };
  }

  const availableCommands = new Set(capabilities.commands);
  const missingCommands = (policy.commands ?? []).filter(
    (command) => !availableCommands.has(command),
  );
  if (missingCommands.length > 0) {
    return {
      pluginId,
      enabled: false,
      policy,
      action: "disable",
      reason: `missing command ${missingCommands.join(",")}`,
    };
  }

  return { pluginId, enabled: true, policy, action: "enable", reason: "host matches policy" };
}

function upsertCodexPluginEnabled(rawConfig: string, pluginId: string, enabled: boolean): string {
  const sectionPattern = new RegExp(
    `(^\\[plugins\\.(?:${tomlSectionNamePattern(pluginId)})\\]\\n)([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m",
  );
  const sectionMatch = rawConfig.match(sectionPattern);
  if (!sectionMatch) {
    return `${rawConfig.trimEnd()}\n\n[plugins.${JSON.stringify(pluginId)}]\nenabled = ${enabled}\n`;
  }

  const [section, header = "", body = ""] = sectionMatch;
  const enabledPattern = /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?$)/m;
  const nextBody = enabledPattern.test(body)
    ? body.replace(enabledPattern, `$1${enabled}$3`)
    : `${body.trimEnd()}\nenabled = ${enabled}\n`;

  if (nextBody === body) {
    return rawConfig;
  }

  return rawConfig.replace(section, `${header}${nextBody}`);
}

function tomlSectionNamePattern(value: string): string {
  return `${escapeRegExp(value)}|${escapeRegExp(JSON.stringify(value))}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
