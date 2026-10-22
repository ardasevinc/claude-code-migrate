import { createHash } from "node:crypto";
import { type BigIntStats, constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
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
  expected: BigIntStats,
): Promise<{ size: number; mode: number; sha256: string }> {
  // Open once, without following a replacement symlink or blocking on a FIFO.
  const handle = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new BlockedError(`Archive source is not a regular file: ${JSON.stringify(sourcePath)}`);
    }
    if (
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size !== expected.size ||
      before.mode !== expected.mode ||
      before.mtimeNs !== expected.mtimeNs ||
      before.ctimeNs !== expected.ctimeNs
    ) {
      throw new BlockedError(
        `Archive source changed before staging: ${JSON.stringify(sourcePath)}`,
      );
    }
    if (before.size > BigInt(MAX_ARCHIVE_FILE_BYTES)) {
      throw new BlockedError(`Archive file size limit exceeded: ${JSON.stringify(sourcePath)}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > MAX_ARCHIVE_FILE_BYTES || BigInt(size) > before.size) {
          callback(
            new BlockedError(`Archive source grew while staging: ${JSON.stringify(sourcePath)}`),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(sourcePath, { fd: handle.fd, autoClose: false }),
      hasher,
      createWriteStream(destPath, { flags: "wx", mode: 0o600 }),
    );
    const after = await handle.stat({ bigint: true });
    const lexical = await lstat(sourcePath, { bigint: true });
    if (
      !lexical.isFile() ||
      lexical.dev !== before.dev ||
      lexical.ino !== before.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(size) !== after.size
    ) {
      throw new BlockedError(`Archive source changed while staging: ${JSON.stringify(sourcePath)}`);
    }
    const mode = Number(after.mode & 0o111n) === 0 ? 0o644 : 0o755;
    await chmod(destPath, mode);
    return { size, mode, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
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
  const sourceStats = new Map<string, BigIntStats>();
  for (const file of files) {
    if (file.mcpServersOnly !== undefined) continue;
    const sourceStat = await lstat(file.sourcePath, { bigint: true }).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new BlockedError(
        `Archive source is not a regular file: ${JSON.stringify(file.relativePath)}`,
      );
    }
    sourceStats.set(file.sourcePath, sourceStat);
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
        const staged = await stagePayloadFile(
          file.sourcePath,
          destPath,
          sourceStats.get(file.sourcePath) as BigIntStats,
        );
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
