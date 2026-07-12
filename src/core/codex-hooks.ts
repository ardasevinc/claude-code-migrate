import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parse } from "smol-toml";

const PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;

interface HookHandler {
  type: string;
  command?: string;
  commandWindows?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
}

interface HookState {
  enabled?: boolean;
  trusted_hash?: string;
}

interface CodexHookStateConfig {
  hooks?: { state?: Record<string, HookState> };
}

export interface CodexHookAdaptation {
  hooksContent: string;
  configContent: string;
  changes: string[];
  warnings: string[];
  trusted: number;
}

const EVENT_LABELS: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
};

export async function adaptCodexHooksForHost(
  rawHooks: string,
  rawConfig: string,
  targetHooksPath: string,
  resolveCommandPath: (binaryName: string) => Promise<string | null>,
  options: { preserveVerifiedTrust?: boolean } = {},
): Promise<CodexHookAdaptation> {
  const preserveVerifiedTrust = options.preserveVerifiedTrust ?? true;
  const hooksFile = JSON.parse(rawHooks) as HooksFile;
  const parsedConfig = parse(rawConfig) as unknown as CodexHookStateConfig;
  const states = parsedConfig.hooks?.state ?? {};
  const changes: string[] = [];
  const warnings: string[] = [];
  const targetStates = new Map<string, HookState>();
  const consumedStateKeys = new Set<string>();
  let trusted = 0;

  for (const [eventName, groups] of Object.entries(hooksFile.hooks ?? {})) {
    const eventLabel = EVENT_LABELS[eventName];
    if (!eventLabel) continue;

    for (const [groupIndex, group] of groups.entries()) {
      for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
        if (handler.type !== "command" || typeof handler.command !== "string") continue;

        const suffix = `:${eventLabel}:${groupIndex}:${handlerIndex}`;
        const targetKey = `${targetHooksPath}${suffix}`;
        const matchingStateEntries = Object.entries(states).filter(([key]) => key.endsWith(suffix));
        const sourceStateEntry =
          matchingStateEntries.find(([key]) => key === targetKey) ?? matchingStateEntries[0];
        for (const [key] of matchingStateEntries) consumedStateKeys.add(key);
        const originalHash = commandHookHash(eventLabel, group.matcher, handler);

        if (PATH_PATTERN.test(handler.command)) {
          const resolved = await resolveCommandPath(basename(handler.command));
          if (!resolved) {
            warnings.push(
              `${eventName}[${groupIndex}].hooks[${handlerIndex}]: ${basename(handler.command)} not found on target`,
            );
          } else if (resolved !== handler.command) {
            changes.push(`${handler.command} -> ${resolved}`);
            handler.command = resolved;
          }
        }

        if (!sourceStateEntry) continue;
        const [, sourceState] = sourceStateEntry;
        const targetState: HookState = {};

        if (typeof sourceState.enabled === "boolean") {
          targetState.enabled = sourceState.enabled;
        }

        if (
          preserveVerifiedTrust &&
          sourceState.trusted_hash === originalHash &&
          !warnings.some((warning) =>
            warning.includes(`${eventName}[${groupIndex}].hooks[${handlerIndex}]`),
          )
        ) {
          targetState.trusted_hash = commandHookHash(eventLabel, group.matcher, handler);
          trusted += 1;
        }

        if (Object.keys(targetState).length > 0) {
          targetStates.set(targetKey, targetState);
        }
      }
    }
  }

  let configContent = rawConfig;
  for (const key of consumedStateKeys) {
    configContent = removeHookStateSection(configContent, key);
  }
  configContent = appendHookStates(configContent, targetStates);

  return {
    hooksContent: `${JSON.stringify(hooksFile, null, 2)}\n`,
    configContent,
    changes,
    warnings,
    trusted,
  };
}

function commandHookHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: HookHandler,
): string {
  const normalizedHandler: Record<string, unknown> = {
    type: "command",
    command: handler.command,
    timeout: Math.max(handler.timeout ?? 600, 1),
    async: handler.async ?? false,
  };
  if (handler.statusMessage !== undefined) normalizedHandler.statusMessage = handler.statusMessage;

  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    hooks: [normalizedHandler],
  };
  if (matcher !== undefined) identity.matcher = matcher;

  const canonical = canonicalize(identity);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function removeHookStateSection(rawConfig: string, key: string): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const start = rawConfig.indexOf(header);
  if (start === -1) return rawConfig;
  const next = rawConfig.indexOf("\n[", start + header.length);
  const end = next === -1 ? rawConfig.length : next + 1;
  return `${rawConfig.slice(0, start)}${rawConfig.slice(end)}`;
}

function appendHookStates(rawConfig: string, states: Map<string, HookState>): string {
  if (states.size === 0) return rawConfig;
  let content = rawConfig.trimEnd();

  for (const [key, state] of states) {
    content += `\n\n[hooks.state.${JSON.stringify(key)}]`;
    if (typeof state.enabled === "boolean") content += `\nenabled = ${state.enabled}`;
    if (state.trusted_hash) content += `\ntrusted_hash = ${JSON.stringify(state.trusted_hash)}`;
  }

  return `${content}\n`;
}
