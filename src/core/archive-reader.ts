import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Transform, Writable } from "node:stream";
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
  destination?: string;
}

export async function verifyArchive(
  archivePath: string,
  options: { extractTo?: string; limits?: Partial<ArchiveLimits> } = {},
): Promise<VerifiedArchive> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  validateLimits(limits);
  const destination = options.extractTo;
  const archiveHash = createHash("sha256");
  let compressedBytes = 0;
  let expandedBytes = 0;
  let entryCount = 0;
  let manifestBytes: Buffer | undefined;
  const files: ObservedFile[] = [];
  const paths = new Set<string>();
  const portablePaths = new Map<string, string>();
  const parser = extract();

  let ownsDestination = false;
  if (destination !== undefined) {
    await mkdir(destination, { mode: 0o700 });
    ownsDestination = true;
  }
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
    if (paths.has(path)) throw new Error(`Duplicate archive member: ${path}`);
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      const portable = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const existing = portablePaths.get(portable);
      if (existing !== undefined && existing !== prefix) {
        throw new Error(`Non-portable archive path collision: ${path}`);
      }
      portablePaths.set(portable, prefix);
    }
    paths.add(path);
    if (directory) {
      if (destination !== undefined) {
        await mkdir(join(destination, path), { recursive: true, mode: 0o700 });
      }
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
    const outputPath = destination === undefined ? undefined : join(destination, path);
    if (outputPath !== undefined) {
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    }
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > max) return callback(new Error("Archive file size limit exceeded"));
        hash.update(chunk);
        if (path === ".ccm-manifest.json") chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
    });
    const sink =
      outputPath === undefined
        ? new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          })
        : createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    await pipeline(stream, counter, sink);
    if (size !== declaredSize) throw new Error(`Archive member size mismatch: ${path}`);
    const mode = (header.mode ?? 0) & 0o777;
    if (outputPath !== undefined) await chmod(outputPath, mode);
    if (path === ".ccm-manifest.json") manifestBytes = Buffer.concat(chunks);
    else
      files.push({
        path,
        size,
        mode,
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
      manifest = parseArchiveManifest(
        parseJsonWithoutDuplicateKeys(manifestBytes.toString("utf8")),
      );
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
    return result;
  } catch (error) {
    if (ownsDestination && destination !== undefined) {
      await rm(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset++] === '"') {
        return JSON.parse(source.slice(start, offset)) as string;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] !== "}") {
        while (true) {
          whitespace();
          if (source[offset] !== '"') throw new SyntaxError("Expected JSON object key");
          const key = string();
          if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key: ${key}`);
          keys.add(key);
          whitespace();
          if (source[offset++] !== ":") throw new SyntaxError("Expected ':'");
          value();
          whitespace();
          if (source[offset] === "}") break;
          if (source[offset++] !== ",") throw new SyntaxError("Expected ','");
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] !== "]") {
        while (true) {
          value();
          whitespace();
          if (source[offset] === "]") break;
          if (source[offset++] !== ",") throw new SyntaxError("Expected ','");
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(offset),
    );
    if (!match) throw new SyntaxError("Invalid JSON value");
    offset += match[0].length;
  };
  value();
  whitespace();
  if (offset !== source.length) throw new SyntaxError("Unexpected JSON input");
  return JSON.parse(source) as unknown;
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
