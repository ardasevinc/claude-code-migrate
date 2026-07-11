import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { isProviderName } from "../config/providers.ts";
import type { FileEntry, Manifest, ProviderName } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
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

export async function createArchive(files: FileEntry[], outputPath: string): Promise<string> {
  const tempDir = join(dirname(outputPath), `.ccm-temp-${Date.now()}`);

  try {
    await mkdir(tempDir, { recursive: true });

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

    const archiveDir = dirname(outputPath);

    await mkdir(archiveDir, { recursive: true });
    await runCommand(`tar -czf ${shellQuote(outputPath)} -C ${shellQuote(tempDir)} .`, {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    log.success(`Created archive: ${outputPath}`);
    return outputPath;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<Manifest | null> {
  try {
    await validateArchive(archivePath);
    await mkdir(destDir, { recursive: true });
    await runCommand(`tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(destDir)}`);

    const manifestPath = join(destDir, MANIFEST_FILENAME);

    if (await exists(manifestPath)) {
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Manifest;
      return manifest;
    }

    return null;
  } catch (error) {
    log.error(`Failed to extract archive: ${error}`);
    return null;
  }
}

export async function validateArchive(archivePath: string): Promise<void> {
  const entriesResult = await runCommand(`tar -tzf ${shellQuote(archivePath)}`, { quiet: true });
  const entries = entriesResult.stdout.split("\n").filter(Boolean);

  validateArchiveEntryPaths(entries);

  const typesResult = await runCommand(`tar -tvzf ${shellQuote(archivePath)}`, { quiet: true });
  for (const line of typesResult.stdout.split("\n").filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Unsafe archive entry type: ${type ?? "unknown"}`);
    }
  }
}

export function validateArchiveEntryPaths(entries: string[]): void {
  if (entries.length === 0) {
    throw new Error("Archive is empty");
  }

  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, "");
    if (normalized.length === 0) {
      continue;
    }

    const segments = normalized.split("/");

    if (normalized.startsWith("/") || segments.some((segment) => segment === "..")) {
      throw new Error(`Unsafe archive path: ${entry}`);
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
