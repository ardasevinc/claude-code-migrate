import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { FileEntry, ProviderName } from "../types/index.ts";
import { BlockedError } from "../errors.ts";
import { createArchive } from "./archiver.ts";
import {
  inventoryFingerprint,
  inventoryFromFileEntries,
  type InventoryEntry,
} from "./inventory.ts";
import {
  createMigrationPlan,
  fingerprint,
  type EndpointRef,
  type MigrationPlan,
  type PlanFingerprint,
} from "./migration-plan.ts";

interface BackupPlanResources {
  readonly files: readonly FileEntry[];
  readonly outputPath: string;
  readonly providers: readonly ProviderName[];
  readonly force: boolean;
  readonly beforePublishTestHook?: () => Promise<void>;
}

export interface PlannedBackup {
  readonly plan: MigrationPlan;
}

export interface PlanBackupInput {
  readonly files: readonly FileEntry[];
  readonly outputPath: string;
  readonly providers: readonly ProviderName[];
  readonly force: boolean;
  readonly createdAt?: string;
  readonly outputSource?: "default" | "explicit";
  readonly outputIdentity?: string;
  /** Deterministic race seam for tests. Not represented in the public plan. */
  readonly beforePublishTestHook?: () => Promise<void>;
}

const resources = new WeakMap<PlannedBackup, BackupPlanResources>();

function endpointRef(domain: string, value: string): EndpointRef {
  return `endpoint_${createHash("sha256").update(`ccm:${domain}\0${value}`).digest("hex")}`;
}

async function targetFingerprint(path: string): Promise<PlanFingerprint> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return fingerprint("backup-target-v1", { exists: false });
  if (!stat.isFile()) return fingerprint("backup-target-v1", { exists: true, type: "other" });
  const bytes = await readFile(path);
  return fingerprint("backup-target-v1", {
    exists: true,
    type: "file",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function targetKind(path: string): Promise<"missing" | "file" | "other"> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return "missing";
  return stat.isFile() ? "file" : "other";
}

export async function planBackup(input: PlanBackupInput): Promise<PlannedBackup> {
  const inventory = await inventoryFromFileEntries(input.files);
  const sourceFingerprint = inventoryFingerprint(inventory);
  const observedTarget = await targetFingerprint(input.outputPath);
  const missingTarget = fingerprint("backup-target-v1", { exists: false });
  const observedTargetKind = await targetKind(input.outputPath);
  const targetAvailable =
    observedTargetKind === "missing" || (input.force && observedTargetKind === "file");
  const expectedTarget = input.force ? observedTarget : missingTarget;
  const outputSource = input.outputSource ?? "explicit";
  const plan = createMigrationPlan({
    kind: "backup",
    providers: input.providers,
    executionModel: "local-atomic-publication",
    sourceEndpointRef: endpointRef("backup-source", sourceFingerprint),
    targetEndpointRef:
      outputSource === "default"
        ? endpointRef("backup-target", "output:default")
        : endpointRef("backup-target", input.outputIdentity ?? input.outputPath),
    sourceFingerprint,
    targetFingerprint: observedTarget,
    stagedPostFingerprint: sourceFingerprint,
    preconditions: [
      {
        id: "target-available",
        required: true,
        status: targetAvailable ? "satisfied" : "failed",
        reasonCode:
          observedTargetKind === "other"
            ? "target-not-file"
            : targetAvailable
              ? "target-available"
              : "target-exists",
        expectedFingerprint: expectedTarget,
        observedFingerprint: observedTarget,
      },
    ],
    actions: [
      {
        operation: "archive",
        disposition: observedTarget === missingTarget ? "create" : "update",
        phase: "commit",
        scope: "shared",
        sourceRef: "collected-managed-files",
        targetRef: "local-backup-archive",
        beforeFingerprint: observedTarget,
        afterFingerprint: sourceFingerprint,
        reversibility: "reversible",
        policyProvenance: [input.force ? "force.cli" : "no-replace.default"],
      },
    ],
    dependencies: [],
    warnings: [],
    policies: [
      {
        code: "archive-replacement",
        valueCode: input.force ? "force" : "no-replace",
        provenance: input.force ? "cli" : "default",
      },
      {
        code: "output-source",
        valueCode: outputSource,
        provenance: outputSource === "explicit" ? "cli" : "default",
      },
    ],
    createdAt: input.createdAt,
  });
  const planned = Object.freeze({ plan });
  resources.set(planned, {
    files: input.files.map((file) => Object.freeze({ ...file })),
    outputPath: input.outputPath,
    providers: [...input.providers],
    force: input.force,
    beforePublishTestHook: input.beforePublishTestHook,
  });
  return planned;
}

function archiveInventory(
  files: readonly { path: string; mode: number; size: number; sha256?: string }[],
): readonly InventoryEntry[] {
  return files.map((file) => {
    if (!file.sha256) throw new BlockedError("Created archive does not provide payload hashes");
    return {
      path: file.path,
      type: "file",
      mode: (file.mode & 0o111) === 0 ? 0o644 : 0o755,
      size: file.size,
      sha256: file.sha256,
    };
  });
}

export async function executePlannedBackup(planned: PlannedBackup): Promise<string> {
  const sealed = resources.get(planned);
  if (!sealed) throw new BlockedError("Backup plan is not a sealed planner result");
  if (planned.plan.status === "blocked") throw new BlockedError("Backup plan is blocked");
  const sourceFingerprint = inventoryFingerprint(await inventoryFromFileEntries(sealed.files));
  if (sourceFingerprint !== planned.plan.sourceFingerprint) {
    throw new BlockedError("Backup source changed after planning");
  }
  const observedTarget = await targetFingerprint(sealed.outputPath);
  const targetPrecondition = planned.plan.preconditions.find(
    (item) => item.id === "target-available",
  );
  if (observedTarget !== targetPrecondition?.expectedFingerprint) {
    throw new BlockedError("Backup target changed after planning");
  }
  await createArchive([...sealed.files], sealed.outputPath, {
    providers: [...sealed.providers],
    force: sealed.force,
    beforePublish: async (archive) => {
      await sealed.beforePublishTestHook?.();
      const currentSource = inventoryFingerprint(await inventoryFromFileEntries(sealed.files));
      if (currentSource !== planned.plan.sourceFingerprint) {
        throw new BlockedError("Backup source changed during archive creation");
      }
      const currentTarget = await targetFingerprint(sealed.outputPath);
      if (currentTarget !== targetPrecondition?.expectedFingerprint) {
        throw new BlockedError("Backup target changed during archive creation");
      }
      const stagedFingerprint = inventoryFingerprint(archiveInventory(archive.files));
      if (stagedFingerprint !== planned.plan.stagedPostFingerprint) {
        throw new BlockedError("Staged archive does not match the planned backup");
      }
    },
  });
  return sealed.outputPath;
}
