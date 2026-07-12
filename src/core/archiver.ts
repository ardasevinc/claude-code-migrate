import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
import {
  extractVerifiedArchive,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_MANIFEST_BYTES,
  verifyArchive,
} from "./archive-reader.ts";

const MANIFEST_FILENAME = ".ccm-manifest.json";

async function stagePayloadFile(
  sourcePath: string,
  destPath: string,
): Promise<{ size: number; mode: number; sha256: string }> {
  const before = await stat(sourcePath, { bigint: true });
  if (before.size > BigInt(MAX_ARCHIVE_FILE_BYTES)) {
    throw new BlockedError(`Archive file size limit exceeded: ${JSON.stringify(sourcePath)}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    hasher,
    createWriteStream(destPath, { mode: 0o600 }),
  );
  const after = await stat(sourcePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    BigInt(size) !== after.size
  ) {
    throw new BlockedError(`Archive source changed while staging: ${JSON.stringify(sourcePath)}`);
  }
  const mode = Number(after.mode & 0o111n) === 0 ? 0o644 : 0o755;
  await chmod(destPath, mode);
  return { size, mode, sha256: hash.digest("hex") };
}

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

    const manifestFiles: ArchiveManifestV2File[] = [];
    for (const file of files) {
      const destPath = join(tempDir, file.relativePath);
      const destDir = dirname(destPath);

      await mkdir(destDir, { recursive: true });

      if (file.mcpServersOnly !== undefined) {
        const bytes = Buffer.from(file.mcpServersOnly, "utf8");
        if (bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) {
          throw new BlockedError(
            `Archive virtual file size limit exceeded: ${JSON.stringify(file.relativePath)}`,
          );
        }
        await writeFile(destPath, file.mcpServersOnly, "utf8");
        await chmod(destPath, 0o644);
        manifestFiles.push({
          path: file.relativePath,
          type: "file",
          size: bytes.byteLength,
          mode: 0o644,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        const staged = await stagePayloadFile(file.sourcePath, destPath);
        manifestFiles.push({ path: file.relativePath, type: "file", ...staged });
      }
    }
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const manifest = createArchiveManifestV2({
      createdAt: new Date().toISOString(),
      producer: { name: "claude-code-migrate", version: packageMetadata.version },
      providers: options.providers,
      files: manifestFiles,
    });

    const manifestPath = join(tempDir, MANIFEST_FILENAME);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    if (manifestBytes.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
      throw new BlockedError("Archive manifest size limit exceeded");
    }
    await writeFile(manifestPath, manifestBytes);

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
