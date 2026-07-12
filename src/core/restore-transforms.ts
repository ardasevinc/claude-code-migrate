import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CollectionPaths } from "../types/index.ts";
import {
  adaptCodexConfigForHost,
  getCodexLocalMarketplaceSources,
  rewriteCodexMarketplaceSources,
} from "./codex.ts";
import { adaptCodexHooksForHost } from "./codex-hooks.ts";
import type {
  PrivateCapturedClaudeMcpTarget,
  PrivateRestoreTargetFacts,
  RestoreObservationQueries,
} from "./restore-observation.ts";

interface ConfigPaths {
  notify?: string[];
  mcp_servers?: Record<string, { command?: string }>;
  mcpServers?: Record<string, { command?: string }>;
}

interface HooksFile {
  hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
}

const PATH_PATTERN = /^(\/|\.\/|\.\.\/|~\/)/;

export interface RestoreTransformInputs {
  readonly claudeMcp?: Uint8Array;
  readonly codexConfig?: Uint8Array;
  readonly codexHooks?: Uint8Array;
}

export interface RestoreTransformResult {
  readonly claudeMcp?: Uint8Array;
  readonly codexConfig?: Uint8Array;
  readonly codexHooks?: Uint8Array;
  readonly warnings: readonly string[];
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function strictRecord(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function mergeClaudeMcpStrict(
  incomingBytes: Uint8Array,
  target: PrivateCapturedClaudeMcpTarget,
): Uint8Array {
  const incoming = strictRecord(text(incomingBytes), "Claude MCP archive member");
  const incomingServers = incoming.mcpServers;
  if (
    typeof incomingServers !== "object" ||
    incomingServers === null ||
    Array.isArray(incomingServers)
  ) {
    throw new Error("Claude MCP archive member must contain an mcpServers object");
  }
  const existing = target.exists
    ? strictRecord(text(target.bytes as Uint8Array), "Claude MCP target")
    : {};
  if (
    existing.mcpServers !== undefined &&
    (typeof existing.mcpServers !== "object" ||
      existing.mcpServers === null ||
      Array.isArray(existing.mcpServers))
  ) {
    throw new Error("Claude MCP target mcpServers must be an object");
  }
  const merged = {
    ...existing,
    mcpServers: {
      ...((existing.mcpServers as Record<string, unknown> | undefined) ?? {}),
      ...(incomingServers as Record<string, unknown>),
    },
  };
  return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`);
}

export function deriveRestoreObservationQueries(
  inputs: RestoreTransformInputs,
): RestoreObservationQueries {
  const pathExistence = new Set<string>();
  const hookCommands = new Set<string>();
  const marketplaceNames = new Set<string>();
  if (inputs.codexConfig) {
    const raw = text(inputs.codexConfig);
    for (const source of getCodexLocalMarketplaceSources(raw, "/"))
      marketplaceNames.add(source.name);
    const config = parse(raw) as unknown as ConfigPaths;
    if (typeof config.notify?.[0] === "string" && PATH_PATTERN.test(config.notify[0])) {
      pathExistence.add(config.notify[0]);
    }
    for (const server of Object.values(config.mcp_servers ?? config.mcpServers ?? {})) {
      if (typeof server.command === "string" && PATH_PATTERN.test(server.command)) {
        pathExistence.add(server.command);
      }
    }
  }
  if (inputs.codexHooks) {
    const hooks = JSON.parse(text(inputs.codexHooks)) as HooksFile;
    for (const groups of Object.values(hooks.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (
            hook.type === "command" &&
            typeof hook.command === "string" &&
            PATH_PATTERN.test(hook.command)
          ) {
            hookCommands.add(hook.command);
          }
        }
      }
    }
  }
  return {
    pathExistence: [...pathExistence].sort(),
    hookCommands: [...hookCommands].sort(),
    marketplaceNames: [...marketplaceNames].sort(),
  };
}

function observed(map: ReadonlyMap<string, boolean>, path: string): boolean {
  const value = map.get(path);
  if (value === undefined) throw new Error(`Missing observed path fact: ${path}`);
  return value;
}

export async function transformRestoreInputs(
  inputs: RestoreTransformInputs,
  targetMcp: PrivateCapturedClaudeMcpTarget,
  facts: PrivateRestoreTargetFacts,
  paths: CollectionPaths,
): Promise<RestoreTransformResult> {
  let codexConfig = inputs.codexConfig ? text(inputs.codexConfig) : undefined;
  let codexHooks = inputs.codexHooks ? text(inputs.codexHooks) : undefined;
  const warnings: string[] = [];
  if (codexConfig !== undefined) {
    const marketplaces = await rewriteCodexMarketplaceSources(codexConfig, async (source) =>
      facts.marketplacePayloads.get(source.name)
        ? join(paths.codexDir, ".ccm", "marketplaces", source.name)
        : null,
    );
    codexConfig = marketplaces.content;
    warnings.push(...marketplaces.warnings);
    if (codexHooks !== undefined) {
      const adapted = await adaptCodexHooksForHost(
        codexHooks,
        codexConfig,
        join(paths.codexDir, "hooks.json"),
        async (binaryName) => {
          if (!facts.hookCandidates.has(binaryName)) {
            throw new Error(`Missing observed hook candidate: ${binaryName}`);
          }
          return facts.hookCandidates.get(binaryName) ?? null;
        },
        { preserveVerifiedTrust: false },
      );
      codexHooks = adapted.hooksContent;
      codexConfig = adapted.configContent;
      warnings.push(...adapted.warnings);
    }
    const host = await adaptCodexConfigForHost(codexConfig, async (path) =>
      observed(facts.pathExistence, path),
    );
    codexConfig = host.content;
    warnings.push(...host.warnings);
  }
  return {
    claudeMcp: inputs.claudeMcp ? mergeClaudeMcpStrict(inputs.claudeMcp, targetMcp) : undefined,
    codexConfig: codexConfig === undefined ? undefined : Buffer.from(codexConfig),
    codexHooks: codexHooks === undefined ? undefined : Buffer.from(codexHooks),
    warnings,
  };
}

export function bytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
