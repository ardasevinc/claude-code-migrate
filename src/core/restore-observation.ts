import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import type { CollectionPaths, ProviderName } from "../types/index.ts";
import type { RuntimeContext } from "../runtime/context.ts";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  inventoryFingerprint,
  symlinkInventoryEntry,
  type InventoryEntry,
} from "./inventory.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";

const MAX_MCP_BYTES = 4 * 1024 * 1024;

export interface RestoreObservationQueries {
  readonly pathExistence?: readonly string[];
  readonly hookCommands?: readonly string[];
  readonly marketplaceNames?: readonly string[];
}

export interface RestoreTargetFacts {
  readonly pathExistence: ReadonlyMap<string, boolean>;
  readonly hookCandidates: ReadonlyMap<string, string | null>;
  readonly marketplacePayloads: ReadonlyMap<string, boolean>;
  readonly sharedSkillNames: readonly string[];
}

export interface CapturedClaudeMcpTarget {
  readonly exists: boolean;
  readonly bytes?: Uint8Array;
  readonly fingerprint: PlanFingerprint;
}

export interface RestoreTargetObservation {
  readonly inventory: readonly InventoryEntry[];
  readonly targetFingerprint: PlanFingerprint;
  readonly claudeMcp: CapturedClaudeMcpTarget;
  readonly facts: RestoreTargetFacts;
}

export interface ObserveLocalRestoreTargetInput {
  readonly context: RuntimeContext;
  readonly paths: CollectionPaths;
  readonly selectedProviders: readonly ProviderName[];
  readonly incoming: readonly InventoryEntry[];
  readonly queries?: RestoreObservationQueries;
}

function sha256(domain: string, bytes: Uint8Array): string {
  return createHash("sha256").update(domain).update("\0").update(bytes).digest("hex");
}

async function exists(context: RuntimeContext, path: string): Promise<boolean> {
  try {
    await context.files.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function livePath(paths: CollectionPaths, logical: string): string {
  const segments = logical.split("/");
  if (segments[0] === "claude") return join(paths.claudeDir, ...segments.slice(1));
  if (segments[0] === "codex") return join(paths.codexDir, ...segments.slice(1));
  if (segments[0] === "shared" && segments[1] === "agents") {
    return join(paths.sharedAgentsDir, ...segments.slice(2));
  }
  throw new Error(`Unsupported managed restore path: ${logical}`);
}

async function inventoryTree(
  context: RuntimeContext,
  root: string,
  logicalRoot: string,
): Promise<InventoryEntry[]> {
  let stat: Stats;
  try {
    stat = await context.files.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return [symlinkInventoryEntry(logicalRoot, await context.files.readlink(root))];
  }
  if (stat.isFile()) {
    const bytes = await context.files.readFile(root);
    return [
      {
        path: logicalRoot,
        type: "file",
        mode: (stat.mode & 0o111) === 0 ? 0o644 : 0o755,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  }
  if (!stat.isDirectory())
    throw new Error(`Unsupported special file in restore target: ${logicalRoot}`);
  const result: InventoryEntry[] = [];
  const entries = await context.files.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const childLogical = `${logicalRoot}/${entry.name}`;
    result.push(...(await inventoryTree(context, join(root, entry.name), childLogical)));
  }
  return result;
}

async function captureMcp(
  context: RuntimeContext,
  path: string,
  selected: boolean,
): Promise<CapturedClaudeMcpTarget> {
  if (!selected)
    return {
      exists: false,
      fingerprint: fingerprint("restore-claude-mcp-v1", { observed: false }),
    };
  let stat: Stats;
  try {
    stat = await context.files.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        fingerprint: fingerprint("restore-claude-mcp-v1", { exists: false }),
      };
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error("Claude MCP target must be a regular file");
  if (stat.size > MAX_MCP_BYTES)
    throw new Error(`Claude MCP target exceeds ${MAX_MCP_BYTES} bytes`);
  const bytes = await context.files.readFile(path);
  if (bytes.byteLength > MAX_MCP_BYTES)
    throw new Error(`Claude MCP target exceeds ${MAX_MCP_BYTES} bytes`);
  return {
    exists: true,
    bytes,
    fingerprint: fingerprint("restore-claude-mcp-v1", {
      size: bytes.byteLength,
      mode: (stat.mode & 0o111) === 0 ? 0o644 : 0o755,
      digest: sha256("ccm:restore:claude-mcp-bytes", bytes),
    }),
  };
}

async function sharedSkillNames(context: RuntimeContext, path: string): Promise<string[]> {
  try {
    const entries = await context.files.readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function observeLocalRestoreTarget(
  input: ObserveLocalRestoreTargetInput,
): Promise<RestoreTargetObservation> {
  const { context, paths, incoming, queries = {}, selectedProviders } = input;
  const selected = new Set(selectedProviders);
  const groups = groupManagedTopLevelEntries(incoming).filter((group) => {
    if (group.path.startsWith("claude/")) return selected.has("claude");
    if (group.path.startsWith("codex/")) return selected.has("codex");
    return selected.size > 0;
  });
  const inventory = canonicalInventory(
    (
      await Promise.all(
        groups.map((group) => inventoryTree(context, livePath(paths, group.path), group.path)),
      )
    ).flat(),
  );

  const pathExistence = new Map<string, boolean>();
  for (const path of [...new Set(queries.pathExistence ?? [])].sort()) {
    pathExistence.set(path, await exists(context, path));
  }
  const hookCandidates = new Map<string, string | null>();
  const pathDirs = (context.process.env.PATH ?? "").split(":").filter(Boolean);
  for (const command of [...new Set(queries.hookCommands ?? [])].sort()) {
    const name = basename(command);
    let match: string | null = null;
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      try {
        const stat = await context.files.stat(candidate);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          match = candidate;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    hookCandidates.set(name, match);
  }
  const marketplacePayloads = new Map<string, boolean>();
  for (const name of [...new Set(queries.marketplaceNames ?? [])].sort()) {
    marketplacePayloads.set(
      name,
      await exists(context, join(paths.codexDir, ".ccm", "marketplaces", name)),
    );
  }
  const facts: RestoreTargetFacts = {
    pathExistence,
    hookCandidates,
    marketplacePayloads,
    sharedSkillNames: await sharedSkillNames(context, paths.sharedSkillsDir),
  };
  const claudeMcp = await captureMcp(context, paths.claudeMcpConfigPath, selected.has("claude"));
  const factsDigest = sha256(
    "ccm:restore:host-facts",
    Buffer.from(
      JSON.stringify({
        pathExistence: [...pathExistence.values()],
        hookCandidates: [...hookCandidates.values()].map((value) =>
          value === null ? null : basename(value),
        ),
        marketplacePayloads: [...marketplacePayloads.values()],
        sharedSkillNames: facts.sharedSkillNames,
      }),
    ),
  );
  return {
    inventory,
    claudeMcp,
    facts,
    targetFingerprint: fingerprint("restore-target-v1", {
      inventory: inventoryFingerprint(inventory),
      claudeMcp: claudeMcp.fingerprint,
      factsDigest,
    }),
  };
}
