import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
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

export const MAX_RESTORE_OBSERVATION_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_RESTORE_OBSERVATION_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_RESTORE_OBSERVATION_ENTRIES = 100_000;

export interface RestoreObservationQueries {
  readonly pathExistence?: readonly string[];
  readonly hookCommands?: readonly string[];
  readonly marketplaceNames?: readonly string[];
}

/** Private execution resource. Never serialize this object into a migration plan. */
export interface PrivateRestoreTargetFacts {
  readonly pathExistence: ReadonlyMap<string, boolean>;
  readonly hookCandidates: ReadonlyMap<string, string | null>;
  readonly marketplacePayloads: ReadonlyMap<string, boolean>;
  readonly sharedSkillNames: readonly string[];
}

/** Private execution resource. Raw bytes must never be copied into a migration plan. */
export interface PrivateCapturedClaudeMcpTarget {
  readonly exists: boolean;
  readonly bytes?: Uint8Array;
  readonly fingerprint: PlanFingerprint;
}

export interface RestoreTargetObservation {
  readonly inventory: readonly InventoryEntry[];
  readonly targetFingerprint: PlanFingerprint;
  readonly claudeMcp: PrivateCapturedClaudeMcpTarget;
  readonly facts: PrivateRestoreTargetFacts;
}

export interface ObserveLocalRestoreTargetInput {
  readonly context: RuntimeContext;
  readonly paths: CollectionPaths;
  readonly selectedProviders: readonly ProviderName[];
  readonly incoming: readonly InventoryEntry[];
  readonly queries?: RestoreObservationQueries;
  readonly limits?: { readonly maxEntries?: number };
}

export async function resolveLocalHookCandidate(
  context: RuntimeContext,
  command: string,
): Promise<string | null> {
  const name = basename(command);
  for (const dir of [
    join(context.home, ".local", "bin"),
    join(context.home, ".bun", "bin"),
    join(context.home, "bin"),
    "/usr/local/bin",
    "/usr/bin",
  ]) {
    const candidate = join(dir, name);
    try {
      const stat = await context.files.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
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

interface ObservationBudget {
  bytes: number;
  entries: number;
  maxEntries: number;
}

function consumeObservationEntry(budget: ObservationBudget, count = 1): void {
  budget.entries += count;
  if (budget.entries > budget.maxEntries)
    throw new Error("Restore observation entry count cap exceeded");
}

async function boundedRegularFileRead(
  context: RuntimeContext,
  path: string,
  logicalPath: string,
  budget: ObservationBudget,
): Promise<{ bytes: Uint8Array; stat: Stats }> {
  let handle: FileHandle | undefined;
  try {
    handle = await context.files.open(path, "r");
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Restore target changed shape: ${logicalPath}`);
    if (before.size > MAX_RESTORE_OBSERVATION_FILE_BYTES)
      throw new Error(`Restore observation file cap exceeded: ${logicalPath}`);
    if (budget.bytes + before.size > MAX_RESTORE_OBSERVATION_TOTAL_BYTES)
      throw new Error("Restore observation total byte cap exceeded");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode
    )
      throw new Error(`Restore target changed during observation: ${logicalPath}`);
    budget.bytes += bytes.byteLength;
    return { bytes, stat: before };
  } finally {
    await handle?.close();
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
  budget: ObservationBudget,
): Promise<InventoryEntry[]> {
  let stat: Stats;
  try {
    stat = await context.files.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  consumeObservationEntry(budget);
  if (stat.isSymbolicLink()) {
    const target = await context.files.readlink(root);
    const after = await context.files.lstat(root);
    if (!after.isSymbolicLink() || stat.dev !== after.dev || stat.ino !== after.ino)
      throw new Error(`Restore target changed during observation: ${logicalRoot}`);
    return [symlinkInventoryEntry(logicalRoot, target)];
  }
  if (stat.isFile()) {
    const observed = await boundedRegularFileRead(context, root, logicalRoot, budget);
    if (
      stat.dev !== observed.stat.dev ||
      stat.ino !== observed.stat.ino ||
      stat.mode !== observed.stat.mode
    )
      throw new Error(`Restore target changed during observation: ${logicalRoot}`);
    const { bytes } = observed;
    return [
      {
        path: logicalRoot,
        type: "file",
        mode: (observed.stat.mode & 0o111) === 0 ? 0o644 : 0o755,
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
    result.push(...(await inventoryTree(context, join(root, entry.name), childLogical, budget)));
  }
  const after = await context.files.lstat(root);
  if (!after.isDirectory() || stat.dev !== after.dev || stat.ino !== after.ino)
    throw new Error(`Restore target changed during observation: ${logicalRoot}`);
  return result;
}

async function captureMcp(
  context: RuntimeContext,
  path: string,
  selected: boolean,
  budget: ObservationBudget,
): Promise<PrivateCapturedClaudeMcpTarget> {
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
  consumeObservationEntry(budget);
  if (!stat.isFile()) throw new Error("Claude MCP target must be a regular file");
  const observed = await boundedRegularFileRead(context, path, "claude/.mcp-config.json", budget);
  if (
    stat.dev !== observed.stat.dev ||
    stat.ino !== observed.stat.ino ||
    stat.mode !== observed.stat.mode
  )
    throw new Error("Claude MCP target changed during observation");
  const { bytes } = observed;
  return {
    exists: true,
    bytes,
    fingerprint: fingerprint("restore-claude-mcp-v1", {
      size: bytes.byteLength,
      mode: (observed.stat.mode & 0o111) === 0 ? 0o644 : 0o755,
      digest: sha256("ccm:restore:claude-mcp-bytes", bytes),
    }),
  };
}

async function sharedSkillNames(
  context: RuntimeContext,
  path: string,
  budget: ObservationBudget,
): Promise<string[]> {
  try {
    const stat = await context.files.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Shared skills target must be a regular directory");
    const entries = await context.files.readdir(path, { withFileTypes: true });
    consumeObservationEntry(budget, 1 + entries.length);
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
  const incomingMcp = incoming.some((entry) => entry.path === "claude/.mcp-config.json");
  const managedIncoming = incoming.filter((entry) => entry.path !== "claude/.mcp-config.json");
  const groups = groupManagedTopLevelEntries(managedIncoming).filter((group) => {
    if (group.path.startsWith("claude/")) return selected.has("claude");
    if (group.path.startsWith("codex/")) return selected.has("codex");
    return selected.size > 0;
  });
  const budget: ObservationBudget = {
    bytes: 0,
    entries: 0,
    maxEntries: input.limits?.maxEntries ?? MAX_RESTORE_OBSERVATION_ENTRIES,
  };
  const observedEntries: InventoryEntry[] = [];
  for (const group of groups) {
    observedEntries.push(
      ...(await inventoryTree(context, livePath(paths, group.path), group.path, budget)),
    );
  }

  const hasClaudeMember = incoming.some((entry) => entry.path.startsWith("claude/"));
  const hasSharedMember = managedIncoming.some((entry) => entry.path.startsWith("shared/agents/"));
  const recreatesSharedSkillView = selected.has("claude") && hasClaudeMember && hasSharedMember;
  let postSharedSkillNames: string[] = [];
  if (recreatesSharedSkillView) {
    const existingNames = await sharedSkillNames(context, paths.sharedSkillsDir, budget);
    const incomingNames = managedIncoming
      .filter(
        (entry) =>
          entry.path.split("/").length > 4 && entry.path.startsWith("shared/agents/skills/"),
      )
      .map((entry) => entry.path.split("/")[3])
      .filter((name): name is string => name !== undefined);
    postSharedSkillNames = [...new Set([...existingNames, ...incomingNames])].sort();
    for (const name of postSharedSkillNames) {
      observedEntries.push(
        ...(await inventoryTree(
          context,
          join(paths.claudeDir, "skills", name),
          `claude/skills/${name}`,
          budget,
        )),
      );
    }
  }
  const inventory = canonicalInventory([
    ...new Map(observedEntries.map((entry) => [entry.path, entry])).values(),
  ]);

  const pathExistence = new Map<string, boolean>();
  for (const path of [...new Set(queries.pathExistence ?? [])].sort()) {
    pathExistence.set(path, await exists(context, path));
  }
  const hookCandidates = new Map<string, string | null>();
  for (const command of [...new Set(queries.hookCommands ?? [])].sort()) {
    const name = basename(command);
    hookCandidates.set(name, await resolveLocalHookCandidate(context, name));
  }
  const marketplacePayloads = new Map<string, boolean>();
  for (const name of [...new Set(queries.marketplaceNames ?? [])].sort()) {
    const incomingPayload = managedIncoming.some(
      (entry) =>
        entry.path === `codex/.ccm/marketplaces/${name}` ||
        entry.path.startsWith(`codex/.ccm/marketplaces/${name}/`),
    );
    marketplacePayloads.set(
      name,
      incomingPayload ||
        (await exists(context, join(paths.codexDir, ".ccm", "marketplaces", name))),
    );
  }
  const facts: PrivateRestoreTargetFacts = {
    pathExistence,
    hookCandidates,
    marketplacePayloads,
    sharedSkillNames: postSharedSkillNames,
  };
  const claudeMcp = await captureMcp(
    context,
    paths.claudeMcpConfigPath,
    selected.has("claude") && incomingMcp,
    budget,
  );
  const factsDigest = sha256(
    "ccm:restore:host-facts",
    Buffer.from(
      JSON.stringify({
        pathExistence: [...pathExistence.values()],
        hookCandidates: [...hookCandidates.values()].map((value) =>
          value === null ? null : sha256("ccm:restore:hook-candidate", Buffer.from(value)),
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
