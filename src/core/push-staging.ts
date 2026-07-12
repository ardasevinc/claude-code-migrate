import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry, ProviderName } from "../types/index.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { createArchive, readVerifiedArchive } from "./archiver.ts";
import {
  canonicalInventory,
  type InventoryEntry,
  inventoryFingerprint,
  inventoryFromFileEntries,
} from "./inventory.ts";

export type SealedPushSourceBindings = object;

const bindings = new WeakMap<SealedPushSourceBindings, readonly FileEntry[]>();

export function sealPushSourceBindings(files: readonly FileEntry[]): SealedPushSourceBindings {
  const sealed = Object.freeze({});
  bindings.set(
    sealed,
    files.map((file) => Object.freeze({ ...file })),
  );
  return sealed;
}

export interface StagePushArchiveInput {
  readonly sources: SealedPushSourceBindings;
  readonly transformedBytes: ReadonlyMap<string, Uint8Array>;
  readonly expectedSourceInventory: readonly InventoryEntry[];
  readonly expectedStagedInventory: readonly InventoryEntry[];
  readonly providers: readonly ProviderName[];
  readonly tempRoot?: string;
  readonly beforePublishTestHook?: () => Promise<void>;
}

export interface StagedPushArchive {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  cleanup(): Promise<void>;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function archiveInventory(
  files: readonly { path: string; mode: number; size: number; sha256?: string }[],
): readonly InventoryEntry[] {
  return canonicalInventory(
    files.map((file) => {
      if (!file.sha256) throw new Error("Staged archive does not provide payload hashes");
      return {
        path: file.path,
        type: "file",
        mode: file.mode & 0o111 ? 0o755 : 0o644,
        size: file.size,
        sha256: file.sha256,
      };
    }),
  );
}

export async function stagePushArchive(input: StagePushArchiveInput): Promise<StagedPushArchive> {
  const files = bindings.get(input.sources);
  if (!files) throw new Error("Push source bindings are not sealed");
  const expectedSource = inventoryFingerprint(input.expectedSourceInventory);
  if (inventoryFingerprint(await inventoryFromFileEntries(files)) !== expectedSource)
    throw new Error("Push source changed before archive staging");

  const workspace = await mkdtemp(join(input.tempRoot ?? tmpdir(), "ccm-push-stage-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(workspace, { recursive: true, force: true });
  };
  const unregister = registerInterruptCleanup(cleanup);
  try {
    const overridesDir = join(workspace, "overrides");
    const stagedFiles = files.map((file) => ({ ...file }));
    const byPath = new Map(stagedFiles.map((file) => [file.relativePath, file]));
    for (const [path, bytes] of input.transformedBytes) {
      const file = byPath.get(path);
      if (!file) throw new Error(`Transformed push member has no sealed source: ${path}`);
      const overridePath = join(
        overridesDir,
        String(byPath.size),
        createHash("sha256").update(path).digest("hex"),
      );
      await mkdir(join(overridePath, ".."), { recursive: true });
      await writeFile(overridePath, bytes, { mode: 0o600 });
      file.sourcePath = overridePath;
      file.mcpServersOnly = undefined;
    }
    const archivePath = join(workspace, "push.tar.gz");
    await createArchive(stagedFiles, archivePath, {
      providers: [...input.providers],
      beforePublish: async (archive) => {
        await input.beforePublishTestHook?.();
        if (inventoryFingerprint(await inventoryFromFileEntries(files)) !== expectedSource)
          throw new Error("Push source changed during archive staging");
        if (
          inventoryFingerprint(archiveInventory(archive.files)) !==
          inventoryFingerprint(input.expectedStagedInventory)
        )
          throw new Error("Staged push archive does not match expected inventory");
        if (JSON.stringify(archive.providers) !== JSON.stringify(input.providers))
          throw new Error("Staged push archive does not match expected providers");
      },
    });
    const verified = await readVerifiedArchive(archivePath);
    const digest = await sha256(archivePath);
    if (verified.archiveSha256 !== digest)
      throw new Error("Staged push archive digest changed after verification");
    return Object.freeze({
      archivePath,
      archiveSha256: digest,
      archiveSize: (await lstat(archivePath)).size,
      cleanup: async () => {
        unregister();
        await cleanup();
      },
    });
  } catch (error) {
    unregister();
    await cleanup();
    throw error;
  }
}
