import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { BlockedError } from "../errors.ts";
import type {
  ArchiveManifestV2File,
  FileEntry,
  ProviderName,
  VerifiedArchive,
} from "../types/index.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { log } from "../utils/logger.ts";
import { runProcess } from "../utils/process.ts";
import { validateArchiveFileEntries } from "./archive-entries.ts";
import { createArchiveManifestV2 } from "./archive-manifest.ts";
import { extractVerifiedArchive, verifyArchive } from "./archive-reader.ts";

const MANIFEST_FILENAME = ".ccm-manifest.json";

export interface CreateArchiveOptions {
  providers: ProviderName[];
  force?: boolean;
  beforePublish?: (archive: VerifiedArchive) => Promise<void>;
}

export async function createArchive(
  files: FileEntry[],
  outputPath: string,
  options: CreateArchiveOptions,
): Promise<string> {
  validateArchiveFileEntries(files);
  for (const file of files) {
    if (file.mcpServersOnly !== undefined) continue;
    const sourceStat = await lstat(file.sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new BlockedError(
        `Archive source is not a regular file: ${JSON.stringify(file.relativePath)}`,
      );
    }
  }
  const archiveDir = dirname(outputPath);
  await mkdir(archiveDir, { recursive: true });
  const workspace = await mkdtemp(join(archiveDir, ".ccm-archive-"));
  const tempDir = join(workspace, "contents");
  const tempArchive = join(workspace, "archive.tar.gz");
  const unregisterInterruptCleanup = registerInterruptCleanup(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  try {
    await mkdir(tempDir, { mode: 0o700 });

    for (const file of files) {
      const destPath = join(tempDir, file.relativePath);
      const destDir = dirname(destPath);

      await mkdir(destDir, { recursive: true });

      if (file.mcpServersOnly !== undefined) {
        await writeFile(destPath, file.mcpServersOnly, "utf8");
      } else {
        await copyFile(file.sourcePath, destPath);
      }
      const stagedStat = await stat(destPath);
      await chmod(destPath, stagedStat.mode & 0o111 ? 0o755 : 0o644);
    }

    const manifestFiles: ArchiveManifestV2File[] = [];
    for (const file of files) {
      const stagedPath = join(tempDir, file.relativePath);
      const [bytes, stagedStat] = await Promise.all([readFile(stagedPath), stat(stagedPath)]);
      manifestFiles.push({
        path: file.relativePath,
        type: "file",
        size: bytes.byteLength,
        mode: stagedStat.mode & 0o777,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const manifest = createArchiveManifestV2({
      createdAt: new Date().toISOString(),
      producer: { name: "claude-code-migrate", version: packageMetadata.version },
      providers: options.providers,
      files: manifestFiles,
    });

    const manifestPath = join(tempDir, MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await runProcess("tar", ["-czf", tempArchive, "-C", tempDir, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    await chmod(tempArchive, 0o600);
    const verifiedArchive = await verifyArchive(tempArchive);
    await options.beforePublish?.(verifiedArchive);

    if (options.force) {
      await rename(tempArchive, outputPath);
    } else {
      try {
        await link(tempArchive, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new BlockedError(`Archive already exists: ${outputPath}`);
        }
        throw error;
      }
    }

    log.success(`Created archive: ${outputPath}`);
    return outputPath;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    unregisterInterruptCleanup();
  }
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<VerifiedArchive> {
  try {
    return await extractVerifiedArchive(archivePath, destDir);
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    if ((error as NodeJS.ErrnoException).code === "Z_DATA_ERROR") {
      throw new BlockedError("Archive is invalid or unreadable", { cause: error });
    }
    if (error instanceof Error) throw new BlockedError(error.message, { cause: error });
    throw new BlockedError("Archive is invalid or unreadable", { cause: error });
  }
}

export async function readVerifiedArchive(archivePath: string): Promise<VerifiedArchive> {
  try {
    return await verifyArchive(archivePath);
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    if (error instanceof Error) {
      throw new BlockedError(error.message, { cause: error });
    }
    throw new BlockedError("Archive is invalid or unreadable", { cause: error });
  }
}

export async function validateArchive(archivePath: string): Promise<void> {
  await readVerifiedArchive(archivePath);
}

export function validateArchiveEntryPaths(entries: string[]): void {
  if (entries.length === 0) {
    throw new BlockedError("Archive is empty");
  }

  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, "");
    if (normalized.length === 0) {
      continue;
    }

    const segments = normalized.split("/");

    if (normalized.startsWith("/") || segments.some((segment) => segment === "..")) {
      throw new BlockedError(`Unsafe archive path: ${entry}`);
    }
  }
}
