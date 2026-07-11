import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { isProviderName } from "../config/providers.ts";
import { BlockedError } from "../errors.ts";
import type { FileEntry, Manifest, ProviderName } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import { runProcess } from "../utils/process.ts";
import { validateArchiveFileEntries } from "./archive-entries.ts";
import { getClaudeVersion } from "./version-checker.ts";

const MANIFEST_FILENAME = ".ccm-manifest.json";
function getManifestProviders(files: FileEntry[]): ProviderName[] {
  const providers = new Set<ProviderName>();

  for (const file of files) {
    const firstSegment = file.relativePath.split("/")[0];
    if (isProviderName(firstSegment)) {
      providers.add(firstSegment);
    }
  }

  return Array.from(providers);
}

export interface CreateArchiveOptions {
  force?: boolean;
}

export async function createArchive(
  files: FileEntry[],
  outputPath: string,
  options: CreateArchiveOptions = {},
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

      if (file.mcpServersOnly) {
        await writeFile(destPath, file.mcpServersOnly, "utf8");
      } else {
        await copyFile(file.sourcePath, destPath);
      }
    }

    const manifest: Manifest = {
      version: packageMetadata.version,
      timestamp: new Date().toISOString(),
      sourceHost: hostname(),
      claudeVersion: await getClaudeVersion(),
      providers: getManifestProviders(files),
      files,
    };

    const manifestPath = join(tempDir, MANIFEST_FILENAME);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await runProcess("tar", ["-czf", tempArchive, "-C", tempDir, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    await chmod(tempArchive, 0o600);

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

export async function extractArchive(archivePath: string, destDir: string): Promise<Manifest> {
  await validateArchive(archivePath);
  await mkdir(destDir, { recursive: true });
  await runProcess("tar", ["-xzf", archivePath, "-C", destDir]);

  const manifestPath = join(destDir, MANIFEST_FILENAME);

  if (await exists(manifestPath)) {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      assertLegacyManifest(parsed);
      return parsed;
    } catch (error) {
      throw new BlockedError("Archive manifest is invalid", { cause: error });
    }
  }

  throw new BlockedError("Archive manifest is missing");
}

function assertLegacyManifest(value: unknown): asserts value is Manifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (typeof value.version !== "string" || typeof value.timestamp !== "string") {
    throw new Error("manifest version and timestamp must be strings");
  }
  if (typeof value.sourceHost !== "string") throw new Error("manifest sourceHost must be a string");
  if (value.claudeVersion !== null && typeof value.claudeVersion !== "string") {
    throw new Error("manifest claudeVersion must be a string or null");
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.some((provider) => typeof provider !== "string" || !isProviderName(provider))
  ) {
    throw new Error("manifest providers are invalid");
  }
  if (!Array.isArray(value.files)) throw new Error("manifest files must be an array");

  const files: FileEntry[] = value.files.map((file) => {
    if (
      !isRecord(file) ||
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateArchive(archivePath: string): Promise<void> {
  try {
    const entriesResult = await runProcess("tar", ["-tzf", archivePath]);
    const entries = entriesResult.stdout.split("\n").filter(Boolean);

    validateArchiveEntryPaths(entries);

    const typesResult = await runProcess("tar", ["-tvzf", archivePath]);
    for (const line of typesResult.stdout.split("\n").filter(Boolean)) {
      const type = line[0];
      if (type !== "-" && type !== "d") {
        throw new BlockedError(`Unsafe archive entry type: ${type ?? "unknown"}`);
      }
    }
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("Archive is invalid or unreadable", { cause: error });
  }
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
