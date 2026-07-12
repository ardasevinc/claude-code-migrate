import { isAbsolute, posix, win32 } from "node:path";
import { PROVIDERS, SHARED_MANAGED_ENTRIES } from "../config/providers.ts";
import type { FileEntry } from "../types/index.ts";

const RESERVED_ARCHIVE_PATHS = new Set([".ccm-manifest.json"]);

export function normalizeArchivePath(rawPath: string, directory = false): string | null {
  let path = rawPath;
  if (path.startsWith("./")) path = path.slice(2);
  if (directory && path.endsWith("/")) path = path.slice(0, -1);
  if (directory && (path === "" || path === ".")) return null;
  validateCanonicalArchivePath(path);
  return path;
}

export function validateCanonicalArchivePath(path: string): void {
  const segments = path.split("/");
  const hasControlCharacter = Array.from(path).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    hasControlCharacter ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`);
  }
}

export function validateArchiveFileEntries(files: FileEntry[]): void {
  const destinations = new Set<string>();

  for (const file of files) {
    const path = file.relativePath;
    try {
      validateCanonicalArchivePath(path);
    } catch {
      throw new Error(`Unsafe archive destination: ${JSON.stringify(path)}`);
    }
    if (RESERVED_ARCHIVE_PATHS.has(path)) {
      throw new Error(`Unsafe archive destination: ${JSON.stringify(path)}`);
    }

    if (destinations.has(path)) {
      throw new Error(`Duplicate archive destination: ${path}`);
    }
    if (!isAllowedManagedPath(path, false)) {
      throw new Error(`Archive destination is not managed by ccm: ${path}`);
    }
    destinations.add(path);
  }
}

export function validateArchiveMemberPaths(paths: string[]): string[] {
  const normalizedPaths: string[] = [];

  for (const rawPath of paths) {
    const directory = rawPath.endsWith("/");
    const path = normalizeArchivePath(rawPath, directory);
    if (path === null) continue;
    if (path === ".ccm-manifest.json") {
      if (directory) throw new Error("Archive manifest must be a regular file");
      normalizedPaths.push(path);
      continue;
    }
    if (!isAllowedManagedPath(path, directory)) {
      throw new Error(`Archive member is not managed by ccm: ${path}`);
    }
    normalizedPaths.push(path);
  }

  return normalizedPaths;
}

function isAllowedManagedPath(path: string, directory: boolean): boolean {
  const [root, ...rest] = path.split("/");
  if ((root === "claude" || root === "codex") && rest.length === 0) return directory;

  if (root === "claude") {
    return matchesManagedEntry(
      rest.join("/"),
      [
        ...PROVIDERS.claude.alwaysInclude,
        ...PROVIDERS.claude.includeIfExists,
        "settings.local.json",
        ".mcp-config.json",
      ],
      new Set(["agents", "skills", "hooks"]),
      directory,
    );
  }

  if (root === "codex") {
    const relativePath = rest.join("/");
    if (
      (PROVIDERS.codex.neverMigratePaths ?? []).some(
        (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
      )
    ) {
      return false;
    }
    return matchesManagedEntry(
      relativePath,
      [
        ...PROVIDERS.codex.alwaysInclude,
        ...PROVIDERS.codex.includeIfExists,
        ".ccm",
        ".tmp/plugins",
        ".tmp/plugins.sha",
      ],
      new Set(["agents", "rules", "skills", ".ccm", ".tmp/plugins"]),
      directory,
    );
  }

  if (root !== "shared") return false;
  if (rest.length === 0) return directory;
  if (rest[0] !== "agents") return false;
  if (rest.length === 1) return directory;
  return matchesManagedEntry(
    rest.slice(1).join("/"),
    SHARED_MANAGED_ENTRIES,
    new Set(["skills", "lazy-skills"]),
    directory,
  );
}

function matchesManagedEntry(
  path: string,
  entries: string[],
  directoryEntries: Set<string>,
  directory: boolean,
): boolean {
  return entries.some(
    (entry) =>
      (path === entry && (!directory || directoryEntries.has(entry))) ||
      (directoryEntries.has(entry) && path.startsWith(`${entry}/`)) ||
      (directory && entry.startsWith(`${path}/`)),
  );
}
