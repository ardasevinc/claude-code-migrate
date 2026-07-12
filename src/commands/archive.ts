import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyArchive } from "../core/archive-reader.ts";
import { BlockedError } from "../errors.ts";
import type { VerifiedArchive } from "../types/index.ts";

interface ArchiveCommandOptions {
  files?: boolean;
  json?: boolean;
}

export async function inspectCommand(
  archiveArg: string,
  options: ArchiveCommandOptions,
): Promise<void> {
  const result = await readArchive(archiveArg, options.json ?? false);
  if (!result) return;

  if (options.json) {
    console.log(JSON.stringify(project(result, options.files ?? false)));
    return;
  }

  printSummary(result);
  if (options.files) {
    console.log("Files:");
    for (const file of result.files) console.log(`  ${file.path} (${file.size} bytes)`);
  }
}

export async function verifyCommand(
  archiveArg: string,
  options: Pick<ArchiveCommandOptions, "json">,
): Promise<void> {
  const result = await readArchive(archiveArg, options.json ?? false);
  if (!result) return;
  const valid = result.integrity === "verified";

  if (options.json) console.log(JSON.stringify({ valid, ...project(result, false) }));
  else if (valid) console.log("Archive integrity verified.");
  else
    console.log("Archive is valid, but integrity verification is unavailable for legacy archives.");

  if (!valid) process.exitCode = 1;
}

async function readArchive(
  archiveArg: string,
  json: boolean,
): Promise<VerifiedArchive | undefined> {
  const archivePath = resolve(archiveArg);
  try {
    await access(archivePath);
    return await verifyArchive(archivePath);
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ valid: false, error: "Archive is invalid or unreadable" }));
      process.exitCode = 3;
      return undefined;
    }
    throw new BlockedError("Archive is invalid or unreadable", { cause: error });
  }
}

function project(result: VerifiedArchive, includeFiles: boolean): Record<string, unknown> {
  return {
    format: result.format,
    integrity: result.integrity,
    providers: result.providers,
    producerVersion: result.producerVersion,
    createdAt: result.createdAt,
    archiveSha256: result.archiveSha256,
    compressedBytes: result.compressedBytes,
    expandedBytes: result.expandedBytes,
    payloadBytes: result.payloadBytes,
    entryCount: result.entryCount,
    ...(includeFiles ? { files: result.files } : {}),
  };
}

function printSummary(result: VerifiedArchive): void {
  console.log(`Format: ${result.format}`);
  console.log(`Integrity: ${result.integrity}`);
  console.log(`Providers: ${result.providers.join(", ")}`);
  console.log(`Producer version: ${result.producerVersion}`);
  console.log(`Created: ${result.createdAt}`);
  console.log(`Archive SHA-256: ${result.archiveSha256}`);
  console.log(`Entries: ${result.entryCount}`);
  console.log(`Payload bytes: ${result.payloadBytes}`);
}
