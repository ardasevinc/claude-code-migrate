import { isProviderName } from "../config/providers.ts";
import type {
  ArchiveManifest,
  ArchiveManifestV2,
  ArchiveManifestV2File,
  FileEntry,
  LegacyArchiveManifest,
  ProviderName,
} from "../types/index.ts";
import { validateArchiveFileEntries } from "./archive-entries.ts";

const LEGACY_KEYS = new Set([
  "version",
  "timestamp",
  "sourceHost",
  "claudeVersion",
  "providers",
  "files",
]);
const LEGACY_FILE_KEYS = new Set([
  "sourcePath",
  "relativePath",
  "isSymlink",
  "originalSymlinkTarget",
  "mcpServersOnly",
]);
const V2_KEYS = new Set(["formatVersion", "createdAt", "producer", "providers", "files"]);
const PRODUCER_KEYS = new Set(["name", "version"]);
const V2_FILE_KEYS = new Set(["path", "type", "size", "mode", "sha256"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown key '${unknown}'`);
}

function date(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid date`);
  }
  return value;
}

function providers(value: unknown): ProviderName[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("manifest providers are invalid");
  const result: ProviderName[] = [];
  for (const provider of value) {
    if (typeof provider !== "string" || !isProviderName(provider) || result.includes(provider)) {
      throw new Error("manifest providers are invalid");
    }
    result.push(provider);
  }
  return result;
}

function parseLegacy(value: Record<string, unknown>): LegacyArchiveManifest {
  exactKeys(value, LEGACY_KEYS, "manifest");
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("manifest version must be a string");
  }
  const timestamp = date(value.timestamp, "manifest timestamp");
  if (typeof value.sourceHost !== "string") throw new Error("manifest sourceHost must be a string");
  if (value.claudeVersion !== null && typeof value.claudeVersion !== "string") {
    throw new Error("manifest claudeVersion must be a string or null");
  }
  const parsedProviders = providers(value.providers);
  if (!Array.isArray(value.files)) throw new Error("manifest files must be an array");
  const files = value.files.map((item): FileEntry => {
    const file = record(item, "manifest file entry");
    exactKeys(file, LEGACY_FILE_KEYS, "manifest file entry");
    if (
      typeof file.sourcePath !== "string" ||
      typeof file.relativePath !== "string" ||
      typeof file.isSymlink !== "boolean" ||
      (file.originalSymlinkTarget !== undefined &&
        typeof file.originalSymlinkTarget !== "string") ||
      (file.mcpServersOnly !== undefined && typeof file.mcpServersOnly !== "string")
    ) {
      throw new Error("manifest file entry is invalid");
    }
    return file as unknown as FileEntry;
  });
  validateArchiveFileEntries(files);
  return {
    version: value.version,
    timestamp,
    sourceHost: value.sourceHost,
    claudeVersion: value.claudeVersion as string | null,
    providers: parsedProviders,
    files,
  };
}

function parseV2(value: Record<string, unknown>): ArchiveManifestV2 {
  exactKeys(value, V2_KEYS, "manifest");
  const createdAt = date(value.createdAt, "manifest createdAt");
  const producer = record(value.producer, "manifest producer");
  exactKeys(producer, PRODUCER_KEYS, "manifest producer");
  if (
    producer.name !== "claude-code-migrate" ||
    typeof producer.version !== "string" ||
    !producer.version
  ) {
    throw new Error("manifest producer is invalid");
  }
  const parsedProviders = providers(value.providers);
  if (!Array.isArray(value.files)) throw new Error("manifest files must be an array");
  const files = value.files.map((item): ArchiveManifestV2File => {
    const file = record(item, "manifest file entry");
    exactKeys(file, V2_FILE_KEYS, "manifest file entry");
    if (
      typeof file.path !== "string" ||
      file.type !== "file" ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      !Number.isSafeInteger(file.mode) ||
      (file.mode as number) < 0 ||
      (file.mode as number) > 0o777 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error("manifest file entry is invalid");
    }
    return file as unknown as ArchiveManifestV2File;
  });
  validateArchiveFileEntries(
    files.map((file) => ({ sourcePath: "", relativePath: file.path, isSymlink: false })),
  );
  const declared = new Set(parsedProviders);
  for (const file of files) {
    const root = file.path.split("/", 1)[0];
    if (isProviderName(root) && !declared.has(root)) {
      throw new Error(`manifest provider '${root}' is not declared`);
    }
  }
  return {
    formatVersion: 2,
    createdAt,
    producer: { name: "claude-code-migrate", version: producer.version },
    providers: parsedProviders,
    files,
  };
}

export function parseArchiveManifest(value: unknown): ArchiveManifest {
  const manifest = record(value, "manifest");
  if (Object.hasOwn(manifest, "formatVersion")) {
    if (manifest.formatVersion !== 2) {
      throw new Error(
        `Unsupported archive manifest formatVersion: ${String(manifest.formatVersion)}`,
      );
    }
    return parseV2(manifest);
  }
  return parseLegacy(manifest);
}

export function createArchiveManifestV2(
  input: Omit<ArchiveManifestV2, "formatVersion">,
): ArchiveManifestV2 {
  return parseArchiveManifest({ formatVersion: 2, ...input }) as ArchiveManifestV2;
}
