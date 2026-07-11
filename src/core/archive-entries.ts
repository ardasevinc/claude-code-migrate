import { isAbsolute, posix, win32 } from "node:path";
import type { FileEntry } from "../types/index.ts";

const RESERVED_ARCHIVE_PATHS = new Set([".ccm-manifest.json"]);

export function validateArchiveFileEntries(files: FileEntry[]): void {
  const destinations = new Set<string>();

  for (const file of files) {
    const path = file.relativePath;
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
      posix.normalize(path) !== path ||
      RESERVED_ARCHIVE_PATHS.has(path)
    ) {
      throw new Error(`Unsafe archive destination: ${JSON.stringify(path)}`);
    }

    if (destinations.has(path)) {
      throw new Error(`Duplicate archive destination: ${path}`);
    }
    destinations.add(path);
  }
}
