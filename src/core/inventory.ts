import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
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
  readonly symlinkTarget?: string;
}

export type InventoryDisposition = "create" | "update" | "unchanged" | "preserve";
export interface InventoryOverlayEntry {
  readonly entry: InventoryEntry;
  readonly disposition: InventoryDisposition;
}

const bytesCompare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

function digest(domain: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`${domain}\0`).update(bytes).digest("hex");
}

export function canonicalInventory(entries: readonly InventoryEntry[]): readonly InventoryEntry[] {
  const sorted = [...entries].sort((a, b) => bytesCompare(a.path, b.path));
  const portablePaths = new Map<string, string>();
  const exact = new Set<string>();
  for (const entry of sorted) {
    validateCanonicalArchivePath(entry.path);
    if (exact.has(entry.path)) throw new Error(`Duplicate inventory path: ${entry.path}`);
    exact.add(entry.path);
    const segments = entry.path.split("/");
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
        symlinkTarget: file.originalSymlinkTarget,
      };
      if (file.isSymlink) {
        const target = binding.symlinkTarget ?? (await readlink(binding.sourcePath));
        const bytes = Buffer.from(target, "utf8");
        return {
          path: file.relativePath,
          type: "symlink",
          mode: 0o755,
          size: bytes.byteLength,
          sha256: digest("ccm:inventory:symlink-target", bytes),
        };
      }
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
        sha256: digest("ccm:inventory:file-content", bytes),
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

export function postInventory(
  target: readonly InventoryEntry[],
  incoming: readonly InventoryEntry[],
): readonly InventoryEntry[] {
  return overlayInventories(target, incoming).map(({ entry }) => entry);
}

export function postInventoryFingerprint(
  target: readonly InventoryEntry[],
  incoming: readonly InventoryEntry[],
): PlanFingerprint {
  return inventoryFingerprint(postInventory(target, incoming));
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
    const depth = segments[0] === "shared" && segments[1] === "agents" ? 3 : 2;
    const path = segments.slice(0, depth).join("/");
    const group = groups.get(path) ?? [];
    group.push(entry);
    groups.set(path, group);
  }
  return [...groups]
    .sort(([a], [b]) => bytesCompare(a, b))
    .map(([path, grouped]) => ({ path, entries: grouped }));
}
