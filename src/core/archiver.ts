import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isProviderName } from "../config/providers.ts";
import type { FileEntry, Manifest, ProviderName } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { runCommand, shellQuote } from "../utils/shell.ts";
import { getClaudeVersion } from "./version-checker.ts";

const MANIFEST_FILENAME = ".ccm-manifest.json";
const PACKAGE_VERSION = "1.3.2";

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
      version: PACKAGE_VERSION,
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
