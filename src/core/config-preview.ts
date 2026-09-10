import { parse } from "smol-toml";
import type { CodexPluginPolicyDecision } from "./codex-plugin-policy.ts";

export function displayText(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

export function describePluginPolicyDecision(decision: CodexPluginPolicyDecision): string {
  let reason = decision.reason;
  if (reason.startsWith("host os "))
    reason = `requires ${(decision.policy.os ?? []).map((os) => (os === "darwin" ? "macOS" : os)).join(" or ")}`;
  else if (reason.startsWith("host gui="))
    reason = decision.policy.gui ? "requires a desktop session" : "requires a headless host";
  else if (reason === "policy mode is never") reason = "disabled by your plugin policy";
  else if (reason === "policy preserves target value")
    reason = "preserves the target's existing setting";
  return `${decision.action === "disable" ? "Disable" : "Keep target setting for"} ${displayText(decision.pluginId)}: ${displayText(reason)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

const safeSettings: Record<string, string> = {
  model: "Model",
  model_reasoning_effort: "Reasoning effort",
  model_reasoning_summary: "Reasoning summary",
  approval_policy: "Approval policy",
  sandbox_mode: "Sandbox permissions",
  web_search: "Web search",
  personality: "Personality",
  service_tier: "Service tier",
  model_context_window: "Context window (tokens)",
  model_auto_compact_token_limit: "Auto-compaction threshold (tokens)",
};

function settingValue(value: unknown): string {
  if (value === undefined) return "default (not set)";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9._+-]{1,96}$/.test(value)) return value;
  return "[value hidden]";
}

const sectionLabels: Record<string, string> = {
  mcp_servers: "MCP server",
  mcpServers: "MCP server",
  plugins: "Plugin",
  marketplaces: "Marketplace",
  agents: "Agent",
  features: "Feature",
  profiles: "Profile",
  projects: "Project permissions",
};

/** Describe meaning and setting names, never arbitrary values, commands, URLs, or credentials. */
export function describeConfigChanges(
  before: Uint8Array | null,
  after: Uint8Array | undefined,
  format: "toml" | "json" = "toml",
): string[] {
  if (after === undefined) return [];
  const decode = (bytes: Uint8Array | null) => {
    if (bytes === null) return {};
    const text = Buffer.from(bytes).toString("utf8");
    return record(format === "toml" ? parse(text) : JSON.parse(text));
  };
  let old: Record<string, unknown>, next: Record<string, unknown>;
  try {
    old = decode(before);
    next = decode(after);
  } catch {
    return ["Replace configuration; existing settings could not be compared."];
  }
  const changes: string[] = [];
  const rank = (key: string) =>
    safeSettings[key] ? 0 : key === "projects" ? 3 : key === "profiles" ? 2 : 1;
  for (const key of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  )) {
    if (canonical(old[key]) === canonical(next[key])) continue;
    const label = safeSettings[key];
    if (label) {
      changes.push(`${label}: ${settingValue(old[key])} -> ${settingValue(next[key])}`);
      continue;
    }
    const section = sectionLabels[key];
    if (
      section &&
      (Object.keys(record(old[key])).length || Object.keys(record(next[key])).length)
    ) {
      const left = record(old[key]),
        right = record(next[key]);
      for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (canonical(left[name]) === canonical(right[name])) continue;
        const action = !(name in left) ? "Add" : !(name in right) ? "Remove" : "Update";
        let detail = "";
        if (key === "plugins" && typeof record(right[name]).enabled === "boolean")
          detail = record(right[name]).enabled ? " (enabled)" : " (disabled)";
        if (key === "features" && typeof right[name] === "boolean")
          detail = right[name] ? " (enabled)" : " (disabled)";
        if (key === "mcp_servers" || key === "mcpServers") {
          const changedFields = Object.keys(record(right[name])).filter(
            (field) =>
              canonical(record(left[name])[field]) !== canonical(record(right[name])[field]),
          );
          if (action === "Update" && changedFields.length)
            detail = ` (${changedFields.map(displayText).join(", ")})`;
        }
        changes.push(`${action} ${section.toLowerCase()} ${displayText(name)}${detail}`);
      }
    } else {
      const action = !(key in old) ? "Add" : !(key in next) ? "Remove" : "Update";
      const name =
        key === "notify"
          ? "notification command"
          : key === "hooks"
            ? "hooks and trust settings"
            : `setting ${displayText(key)}`;
      changes.push(`${action} ${name}`);
    }
  }
  return changes;
}
