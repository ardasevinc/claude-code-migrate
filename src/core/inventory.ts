import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { FileEntry } from "../types/index.ts";
import { validateArchiveFileEntries, validateCanonicalArchivePath } from "./archive-entries.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";

export interface InventoryEntry {
  readonly path: string;
  readonly type: "file" | "symlink";
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}

export interface InventoryBinding {
  readonly sourcePath: string;
  readonly virtualContent?: string | Uint8Array;
}

export type InventoryDisposition = "create" | "update" | "unchanged" | "preserve";
export interface InventoryOverlayEntry {
  readonly entry: InventoryEntry;
  readonly disposition: InventoryDisposition;
}

const bytesCompare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/** Builds a logical symlink entry without retaining or exposing its raw target binding. */
export function symlinkInventoryEntry(path: string, target: string): InventoryEntry {
  const bytes = Buffer.from(target, "utf8");
  const entry: InventoryEntry = {
    path,
    type: "symlink",
    mode: 0o755,
    size: bytes.byteLength,
    sha256: createHash("sha256")
      .update("ccm:inventory:symlink-target\0")
      .update(bytes)
      .digest("hex"),
  };
  validateEntry(entry);
  return entry;
}

function validateEntry(entry: InventoryEntry): void {
  validateCanonicalArchivePath(entry.path);
  validateArchiveFileEntries([
    { sourcePath: "<inventory-binding>", relativePath: entry.path, isSymlink: false },
  ]);
  if (entry.type !== "file" && entry.type !== "symlink") {
    throw new Error(`Invalid inventory type: ${String(entry.type)}`);
  }
  if (entry.mode !== 0o644 && entry.mode !== 0o755) {
    throw new Error(`Invalid inventory mode: ${entry.mode}`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`Invalid inventory size: ${entry.size}`);
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("Invalid inventory sha256");
  }
}

export function canonicalInventory(entries: readonly InventoryEntry[]): readonly InventoryEntry[] {
  const sorted = [...entries].sort((a, b) => bytesCompare(a.path, b.path));
  const portablePaths = new Map<string, string>();
  const exact = new Set<string>();
  for (const entry of sorted) {
    validateEntry(entry);
    if (exact.has(entry.path)) throw new Error(`Duplicate inventory path: ${entry.path}`);
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (exact.has(segments.slice(0, index).join("/"))) {
        throw new Error(`Inventory file ancestor conflict: ${entry.path}`);
      }
    }
    exact.add(entry.path);
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const portable = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const existing = portablePaths.get(portable);
      if (existing !== undefined && existing !== prefix) {
        throw new Error(`Non-portable inventory path collision: ${entry.path}`);
      }
      portablePaths.set(portable, prefix);
    }
  }
  return sorted;
}

export async function inventoryFromFileEntries(
  files: readonly FileEntry[],
): Promise<readonly InventoryEntry[]> {
  validateArchiveFileEntries([...files]);
  const entries = await Promise.all(
    files.map(async (file): Promise<InventoryEntry> => {
      const binding: InventoryBinding = {
        sourcePath: file.sourcePath,
        virtualContent: file.mcpServersOnly,
      };
      const bytes =
        binding.virtualContent === undefined
          ? await readFile(binding.sourcePath)
          : Buffer.from(binding.virtualContent);
      const mode =
        binding.virtualContent === undefined ? (await lstat(binding.sourcePath)).mode : 0o644;
      return {
        path: file.relativePath,
        type: "file",
        mode: (mode & 0o111) === 0 ? 0o644 : 0o755,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  return canonicalInventory(entries);
}

export function inventoryFingerprint(entries: readonly InventoryEntry[]): PlanFingerprint {
  return fingerprint(
    "managed-tree-v1",
    canonicalInventory(entries).map(({ path, type, mode, size, sha256 }) => ({
      path,
      type,
      mode,
      size,
      sha256,
    })),
  );
}

function sameEntry(left: InventoryEntry, right: InventoryEntry): boolean {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

export function overlayInventories(
  target: readonly InventoryEntry[],
  incoming: readonly InventoryEntry[],
): readonly InventoryOverlayEntry[] {
  const targetByPath = new Map(canonicalInventory(target).map((entry) => [entry.path, entry]));
  const incomingByPath = new Map(canonicalInventory(incoming).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...targetByPath.keys(), ...incomingByPath.keys()])].sort(bytesCompare);
  return paths.map((path) => {
    const before = targetByPath.get(path);
    const after = incomingByPath.get(path);
    if (after === undefined) return { entry: before as InventoryEntry, disposition: "preserve" };
    if (before === undefined) return { entry: after, disposition: "create" };
    return { entry: after, disposition: sameEntry(before, after) ? "unchanged" : "update" };
  });
}

/** Raw overlay only. Callers must separately simulate transforms, merges, and symlink recreation. */
export function overlayInventory(
  target: readonly InventoryEntry[],
  incoming: readonly InventoryEntry[],
): readonly InventoryEntry[] {
  return overlayInventories(target, incoming).map(({ entry }) => entry);
}

/** Fingerprint of the raw no-delete overlay, not a staged-post fingerprint. */
export function overlayInventoryFingerprint(
  target: readonly InventoryEntry[],
  incoming: readonly InventoryEntry[],
): PlanFingerprint {
  return inventoryFingerprint(overlayInventory(target, incoming));
}

export interface ManagedEntryGroup {
  readonly path: string;
  readonly entries: readonly InventoryEntry[];
}

export function groupManagedTopLevelEntries(
  entries: readonly InventoryEntry[],
): readonly ManagedEntryGroup[] {
  const groups = new Map<string, InventoryEntry[]>();
  for (const entry of canonicalInventory(entries)) {
    const segments = entry.path.split("/");
    const depth =
      segments[0] === "shared" && segments[1] === "agents"
        ? 3
        : segments[0] === "codex" &&
            segments[1] === ".tmp" &&
            (segments[2] === "plugins" || segments[2] === "plugins.sha")
          ? 3
          : 2;
    const path = segments.slice(0, depth).join("/");
    const group = groups.get(path) ?? [];
    group.push(entry);
    groups.set(path, group);
  }
  return [...groups]
    .sort(([a], [b]) => bytesCompare(a, b))
    .map(([path, grouped]) => ({ path, entries: grouped }));
}
