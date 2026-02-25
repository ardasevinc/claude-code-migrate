import { copyFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { FileEntry, Manifest } from "../types/index.ts";
import { log } from "../utils/logger.ts";
import { getClaudeVersion } from "./version-checker.ts";

const MANIFEST_FILENAME = ".ccm-manifest.json";
const PACKAGE_VERSION = "1.0.0";

export async function createArchive(files: FileEntry[], outputPath: string): Promise<string> {
  const tempDir = join(dirname(outputPath), `.ccm-temp-${Date.now()}`);

  try {
    await Bun.$`mkdir -p ${tempDir}`;

    for (const file of files) {
      const destPath = join(tempDir, file.relativePath);
      const destDir = dirname(destPath);

      await mkdir(destDir, { recursive: true });

      if (file.mcpServersOnly) {
        // Write the extracted mcpServers JSON instead of copying source
        await Bun.write(destPath, file.mcpServersOnly);
      } else {
        await copyFile(file.sourcePath, destPath);
      }
    }

    const manifest: Manifest = {
      version: PACKAGE_VERSION,
      timestamp: new Date().toISOString(),
      sourceHost: hostname(),
      claudeVersion: await getClaudeVersion(),
      files,
    };

    const manifestPath = join(tempDir, MANIFEST_FILENAME);
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

    const archiveDir = dirname(outputPath);

    await Bun.$`mkdir -p ${archiveDir}`;

    // COPYFILE_DISABLE=1 prevents macOS extended attributes from being included
    await Bun.$`COPYFILE_DISABLE=1 tar -czf ${outputPath} -C ${tempDir} .`;

    log.success(`Created archive: ${outputPath}`);
    return outputPath;
  } finally {
    await Bun.$`rm -rf ${tempDir}`.quiet().nothrow();
  }
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<Manifest | null> {
  try {
    await Bun.$`mkdir -p ${destDir}`;
    await Bun.$`tar -xzf ${archivePath} -C ${destDir}`;

    const manifestPath = join(destDir, MANIFEST_FILENAME);
    const manifestFile = Bun.file(manifestPath);

    if (await manifestFile.exists()) {
      const manifest = (await manifestFile.json()) as Manifest;
      return manifest;
    }

    return null;
  } catch (error) {
    log.error(`Failed to extract archive: ${error}`);
    return null;
  }
}
