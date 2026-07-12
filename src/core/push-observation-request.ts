import { readFile } from "node:fs/promises";
import type { CodexPluginPolicy, FileEntry, ProviderName } from "../types/index.ts";
import { groupManagedTopLevelEntries, inventoryFromFileEntries } from "./inventory.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";
import type { PushObservationQueries } from "./push-observation.ts";
import { derivePushObservationQueries, type PushTransformInputs } from "./push-transforms.ts";

export interface PreparedPushObservationRequest {
  readonly host: string;
  readonly inventoryRoots: readonly string[];
  readonly queries: PushObservationQueries;
  readonly requestIdentity: PlanFingerprint;
}

function canonicalQueries(queries: PushObservationQueries): PushObservationQueries {
  const names = (values: readonly string[] | undefined) =>
    values === undefined ? undefined : [...new Set(values)].sort();
  return {
    pathExistence: names(queries.pathExistence),
    commandNames: names(queries.commandNames),
    capturePaths: names(queries.capturePaths),
    captureIds: names(queries.captureIds) as PushObservationQueries["captureIds"],
    marketplaceNames: names(queries.marketplaceNames),
    sharedSkillNames: queries.sharedSkillNames === true,
    codexPluginList: queries.codexPluginList === true,
  };
}

export function pushObservationRequestIdentity(input: {
  readonly host: string;
  readonly inventoryRoots: readonly string[];
  readonly queries: PushObservationQueries;
}): PlanFingerprint {
  const queries = canonicalQueries(input.queries);
  return fingerprint("push-observation-request-v1", {
    host: input.host,
    inventoryRoots: [...new Set(input.inventoryRoots)].sort(),
    queries: {
      pathExistence: queries.pathExistence ?? [],
      commandNames: queries.commandNames ?? [],
      capturePaths: queries.capturePaths ?? [],
      captureIds: queries.captureIds ?? [],
      marketplaceNames: queries.marketplaceNames ?? [],
      sharedSkillNames: queries.sharedSkillNames ?? false,
      codexPluginList: queries.codexPluginList ?? false,
    },
  });
}

export async function preparePushObservationRequest(input: {
  readonly host: string;
  readonly files: readonly FileEntry[];
  readonly providers: readonly ProviderName[];
  readonly policyOverrides?: Readonly<Record<string, CodexPluginPolicy>>;
}): Promise<PreparedPushObservationRequest> {
  const selected = new Set(input.providers);
  const files = input.files.filter((file) => {
    const provider = file.relativePath.split("/", 1)[0];
    return provider === "shared" || selected.has(provider as ProviderName);
  });
  const incoming = await inventoryFromFileEntries(files);
  const inventoryRoots = groupManagedTopLevelEntries(incoming)
    .map((group) => group.path)
    .filter((root) => root !== "claude/.mcp-config.json");
  const hasClaudeRoot = files.some((file) => file.relativePath.startsWith("claude/"));
  const hasSharedRoot = files.some((file) => file.relativePath.startsWith("shared/agents/"));
  if (hasClaudeRoot && hasSharedRoot) inventoryRoots.push("claude/skills");

  const bytes = async (path: string): Promise<Uint8Array | undefined> => {
    const file = files.find((entry) => entry.relativePath === path);
    if (!file) return undefined;
    return file.mcpServersOnly === undefined
      ? readFile(file.sourcePath)
      : Buffer.from(file.mcpServersOnly);
  };
  const transforms: PushTransformInputs = {
    claudeMcp: await bytes("claude/.mcp-config.json"),
    codexConfig: await bytes("codex/config.toml"),
    codexHooks: await bytes("codex/hooks.json"),
  };
  const derived = derivePushObservationQueries(transforms, { ...(input.policyOverrides ?? {}) });
  const queries = canonicalQueries({
    ...derived,
    commandNames: [
      ...(derived.commandNames ?? []),
      ...(derived.codexPluginList ? ["codex"] : []),
      "python3",
    ],
    sharedSkillNames: hasClaudeRoot && hasSharedRoot,
  });
  const roots = [...new Set(inventoryRoots)].sort();
  return {
    host: input.host,
    inventoryRoots: roots,
    queries,
    requestIdentity: pushObservationRequestIdentity({
      host: input.host,
      inventoryRoots: roots,
      queries,
    }),
  };
}
