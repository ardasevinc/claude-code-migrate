import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract, type Headers } from "tar-stream";
import { isProviderName } from "../config/providers.ts";
import type {
  ArchiveManifest,
  ArchiveManifestV2,
  VerifiedArchive,
  VerifiedArchiveFile,
} from "../types/index.ts";
import { normalizeArchivePath, validateArchiveMemberPaths } from "./archive-entries.ts";
import { parseArchiveManifest } from "./archive-manifest.ts";

export const MAX_COMPRESSED_ARCHIVE_BYTES = 1024 ** 3;
export const MAX_EXPANDED_TAR_BYTES = 4 * 1024 ** 3;
export const MAX_ARCHIVE_FILE_BYTES = 1024 ** 3;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_MANIFEST_BYTES = 8 * 1024 ** 2;
export const MAX_ARCHIVE_PATH_BYTES = 4096;

export interface ArchiveLimits {
  compressedBytes: number;
  expandedBytes: number;
  fileBytes: number;
  entries: number;
  manifestBytes: number;
  pathBytes: number;
}

const DEFAULT_LIMITS: ArchiveLimits = {
  compressedBytes: MAX_COMPRESSED_ARCHIVE_BYTES,
  expandedBytes: MAX_EXPANDED_TAR_BYTES,
  fileBytes: MAX_ARCHIVE_FILE_BYTES,
  entries: MAX_ARCHIVE_ENTRIES,
  manifestBytes: MAX_ARCHIVE_MANIFEST_BYTES,
  pathBytes: MAX_ARCHIVE_PATH_BYTES,
};

interface ObservedFile extends VerifiedArchiveFile {
  destination: string;
}

export async function verifyArchive(
  archivePath: string,
  options: { extractTo?: string; limits?: Partial<ArchiveLimits> } = {},
): Promise<VerifiedArchive> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  validateLimits(limits);
  const workspace = options.extractTo ? undefined : await mkdtemp(join(tmpdir(), "ccm-verify-"));
  const destination = options.extractTo ?? workspace;
  if (destination === undefined) throw new Error("Archive extraction destination is unavailable");
  const extractionDestination = destination;
  const archiveHash = createHash("sha256");
  let compressedBytes = 0;
  let expandedBytes = 0;
  let entryCount = 0;
  let manifestBytes: Buffer | undefined;
  const files: ObservedFile[] = [];
  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  const parser = extract();

  await mkdir(destination, { recursive: true, mode: 0o700 });
  parser.on("entry", (header, stream, next) => {
    void consumeEntry(header, stream).then(next, (error: unknown) =>
      parser.destroy(error as Error),
    );
  });

  async function consumeEntry(header: Headers, stream: NodeJS.ReadableStream): Promise<void> {
    entryCount += 1;
    if (entryCount > limits.entries) throw new Error("Archive entry count limit exceeded");
    if (header.type !== "file" && header.type !== "directory") {
      throw new Error(`Unsafe archive entry type: ${header.type ?? "unknown"}`);
    }
    if (Buffer.byteLength(header.name, "utf8") > limits.pathBytes) {
      throw new Error("Archive path length limit exceeded");
    }
    const directory = header.type === "directory";
    const path = normalizeArchivePath(header.name, directory);
    if (path === null) {
      stream.resume();
      return;
    }
    validateArchiveMemberPaths([header.name]);
    const portable = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(path)) throw new Error(`Duplicate archive member: ${path}`);
    if (portablePaths.has(portable))
      throw new Error(`Non-portable archive path collision: ${path}`);
    paths.add(path);
    portablePaths.add(portable);
    if (directory) {
      await mkdir(join(extractionDestination, path), { recursive: true, mode: 0o700 });
      stream.resume();
      return;
    }
    const declaredSize = header.size ?? 0;
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > limits.fileBytes
    ) {
      throw new Error("Archive file size limit exceeded");
    }
    const max = path === ".ccm-manifest.json" ? limits.manifestBytes : limits.fileBytes;
    if (declaredSize > max) throw new Error("Archive file size limit exceeded");
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let size = 0;
    const outputPath = join(extractionDestination, path);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > max) return callback(new Error("Archive file size limit exceeded"));
        hash.update(chunk);
        if (path === ".ccm-manifest.json") chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
    });
    await pipeline(stream, counter, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    if (size !== declaredSize) throw new Error(`Archive member size mismatch: ${path}`);
    if (path === ".ccm-manifest.json") manifestBytes = Buffer.concat(chunks);
    else
      files.push({
        path,
        size,
        mode: (header.mode ?? 0) & 0o777,
        sha256: hash.digest("hex"),
        destination: outputPath,
      });
  }

  try {
    const compressedCounter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > limits.compressedBytes)
          return callback(new Error("Compressed archive size limit exceeded"));
        archiveHash.update(chunk);
        callback(null, chunk);
      },
    });
    const expandedCounter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        expandedBytes += chunk.length;
        if (expandedBytes > limits.expandedBytes)
          return callback(new Error("Expanded archive size limit exceeded"));
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(archivePath),
      compressedCounter,
      createGunzip(),
      expandedCounter,
      parser,
    );
    if (!manifestBytes) throw new Error("Archive manifest is missing");
    let manifest: ArchiveManifest;
    try {
      manifest = parseArchiveManifest(JSON.parse(manifestBytes.toString("utf8")));
    } catch (error) {
      throw new Error("Archive manifest is invalid", { cause: error });
    }
    verifyMembership(manifest, files);
    const legacy = !("formatVersion" in manifest);
    const producerVersion =
      "formatVersion" in manifest ? manifest.producer.version : manifest.version;
    const createdAt = "formatVersion" in manifest ? manifest.createdAt : manifest.timestamp;
    const result: VerifiedArchive = {
      format: legacy ? "v1" : "v2",
      integrity: legacy ? "unavailable" : "verified",
      providers: [...manifest.providers],
      producerVersion,
      createdAt,
      archiveSha256: archiveHash.digest("hex"),
      compressedBytes,
      expandedBytes,
      payloadBytes: files.reduce((total, file) => total + file.size, 0),
      entryCount,
      files: files.map(({ destination: _destination, sha256, ...file }) =>
        legacy ? file : { ...file, sha256 },
      ),
    };
    if (workspace) await rm(workspace, { recursive: true, force: true });
    return result;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export function extractVerifiedArchive(
  archivePath: string,
  destination: string,
  options: { limits?: Partial<ArchiveLimits> } = {},
): Promise<VerifiedArchive> {
  return verifyArchive(archivePath, { ...options, extractTo: destination });
}

function verifyMembership(manifest: ArchiveManifest, files: ObservedFile[]): void {
  const expected =
    "formatVersion" in manifest
      ? manifest.files.map((file) => file.path)
      : manifest.files.map((file) => file.relativePath);
  const actual = files.map((file) => file.path);
  if (expected.length !== actual.length || expected.some((path) => !actual.includes(path))) {
    throw new Error("Archive members do not match the manifest");
  }
  const declaredProviders = new Set(manifest.providers);
  for (const path of actual) {
    const root = path.split("/", 1)[0];
    if (isProviderName(root) && !declaredProviders.has(root)) {
      throw new Error(`Archive provider '${root}' is not declared`);
    }
  }
  if (!("formatVersion" in manifest)) return;
  const observed = new Map(files.map((file) => [file.path, file]));
  for (const declared of (manifest as ArchiveManifestV2).files) {
    const file = observed.get(declared.path);
    if (
      !file ||
      file.size !== declared.size ||
      file.mode !== declared.mode ||
      file.sha256 !== declared.sha256
    ) {
      throw new Error(`Archive member integrity mismatch: ${declared.path}`);
    }
  }
}

function validateLimits(limits: ArchiveLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Archive limits must be positive safe integers");
  }
}
