import { parseJsonWithoutDuplicateKeys } from "./strict-json.ts";

export interface ClaudeSettingsAdaptation {
  content: string;
  changes: string[];
  warnings: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHome(home: string): boolean {
  return (
    /^\/[A-Za-z0-9._/-]+$/.test(home) &&
    !home.endsWith("/") &&
    !home.includes("//") &&
    !home.split("/").some((part) => part === "." || part === "..")
  );
}

const TOKEN_BOUNDARY = /[\s'"=;|&<>()]/;
const FOREIGN_HOME_PATH = /\/(?:Users|home)\/[^\s'"`;|&<>()]+/g;

/** Remap literal home prefixes only; do not interpret shell syntax or expand variables. */
function remapCommand(command: string, sourceHome: string, targetHome: string): string {
  return command.replaceAll(sourceHome, (match, offset: number) => {
    const before = command[offset - 1];
    const after = command[offset + match.length];
    const startsToken = before === undefined || TOKEN_BOUNDARY.test(before);
    const endsHome = after === undefined || after === "/" || TOKEN_BOUNDARY.test(after);
    return startsToken && endsHome ? targetHome : match;
  });
}

/** Adapt Claude's executable settings using an explicitly captured source HOME. */
export function adaptClaudeSettingsForHost(
  raw: string,
  sourceHome: string,
  targetHome: string,
): ClaudeSettingsAdaptation {
  const settings = parseJsonWithoutDuplicateKeys(raw);
  if (!record(settings)) throw new Error("Claude settings must be a JSON object");
  const changes: string[] = [];
  const warnings: string[] = [];
  const canRemap = safeHome(sourceHome) && safeHome(targetHome);
  if (!canRemap) {
    warnings.push("Claude home-path migration skipped: HOME requires unsupported shell escaping");
  }

  const adapt = (handler: Record<string, unknown>, label: string) => {
    if (handler.type !== "command" || typeof handler.command !== "string") return;
    const original = handler.command;
    const command = canRemap ? remapCommand(original, sourceHome, targetHome) : original;
    if (command !== original) {
      handler.command = command;
      changes.push(`${label}: ${sourceHome} -> ${targetHome}`);
    }
    const foreign = [...command.matchAll(FOREIGN_HOME_PATH)].some(([path]) => {
      return path !== targetHome && !path.startsWith(`${targetHome}/`);
    });
    if (foreign)
      warnings.push(`${label}: foreign home path remains; review this command on target`);
  };

  if (record(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const [groupIndex, group] of groups.entries()) {
        if (!record(group) || !Array.isArray(group.hooks)) continue;
        for (const [hookIndex, hook] of group.hooks.entries()) {
          if (record(hook))
            adapt(hook, `hooks.${event}[${groupIndex}].hooks[${hookIndex}].command`);
        }
      }
    }
  }
  if (record(settings.statusLine)) adapt(settings.statusLine, "statusLine.command");
  return {
    content: changes.length ? `${JSON.stringify(settings, null, 2)}\n` : raw,
    changes,
    warnings,
  };
}
