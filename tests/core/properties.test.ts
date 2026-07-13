import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  normalizeArchivePath,
  validateCanonicalArchivePath,
} from "../../src/core/archive-entries.ts";
import { createArchive, extractArchive } from "../../src/core/archiver.ts";
import { resolvePushArguments } from "../../src/core/arg-parser.ts";
import type { FileEntry, ProviderName } from "../../src/types/index.ts";
import { shellQuote } from "../../src/utils/shell.ts";

const PROPERTY_OPTIONS = { numRuns: 100, seed: 20_260_713 } as const;
const safeSegment = fc.stringMatching(/^[a-zA-Z0-9_-]{1,24}$/);
const target = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-_@"), {
    minLength: 1,
    maxLength: 80,
  })
  .map((characters) => characters.join(""))
  .filter((value) => value !== "claude" && value !== "codex");
const enabledProviders = fc.constantFrom<ProviderName[]>(
  ["claude"],
  ["codex"],
  ["claude", "codex"],
);

describe("path containment properties", () => {
  it("round-trips canonical relative paths without widening their root", () => {
    fc.assert(
      fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 8 }), (segments) => {
        const path = segments.join("/");
        expect(() => validateCanonicalArchivePath(path)).not.toThrow();
        expect(normalizeArchivePath(`./${path}`)).toBe(path);
        expect(path.startsWith("/")).toBe(false);
        expect(path.split("/")).not.toContain("..");
      }),
      PROPERTY_OPTIONS,
    );
  });

  it("rejects traversal, absolute, separator-smuggling, and empty-segment variants", () => {
    fc.assert(
      fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 6 }), (segments) => {
        const path = segments.join("/");
        for (const unsafe of [
          `../${path}`,
          `${path}/../escape`,
          `/${path}`,
          `${path}\\escape`,
          `${path}//escape`,
          `${path}/./escape`,
        ]) {
          expect(() => validateCanonicalArchivePath(unsafe)).toThrow("Unsafe archive path");
        }
      }),
      PROPERTY_OPTIONS,
    );
  });
});

describe("shell quoting properties", () => {
  it("preserves every generated argument as one exact POSIX shell word", () => {
    const shellCharacter = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      " ",
      "\t",
      "\n",
      "'",
      '"',
      "$",
      "`",
      "\\",
      ";",
      "&",
      "|",
      "*",
      "?",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "🔥",
      "ğ",
    );
    fc.assert(
      fc.property(fc.array(shellCharacter, { maxLength: 100 }), (characters) => {
        const value = characters.join("");
        const observed = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`]);
        expect(observed).toEqual(Buffer.from(value));
      }),
      PROPERTY_OPTIONS,
    );
  });
});

describe("argument parsing properties", () => {
  it("keeps target-only defaults and positional provider selection unambiguous", () => {
    fc.assert(
      fc.property(
        target,
        enabledProviders,
        fc.constantFrom<ProviderName>("claude", "codex"),
        (host, enabled, provider) => {
          expect(resolvePushArguments(host, undefined, enabled)).toEqual({
            providers: enabled,
            target: host,
          });
          expect(resolvePushArguments(provider, host, enabled)).toEqual({
            providers: [provider],
            target: host,
          });
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it("deduplicates explicit provider lists in first-seen order", () => {
    fc.assert(
      fc.property(
        target,
        enabledProviders,
        fc.array(fc.constantFrom<ProviderName>("claude", "codex"), { minLength: 1, maxLength: 20 }),
        (host, enabled, requested) => {
          const expected = [...new Set(requested)];
          expect(
            resolvePushArguments(host, undefined, enabled, { providers: requested.join(",") }),
          ).toEqual({ providers: expected, target: host });
        },
      ),
      PROPERTY_OPTIONS,
    );
  });
});

describe("archive round-trip properties", () => {
  it("preserves generated managed paths and arbitrary file bytes", async () => {
    const generatedFile = fc.record({
      name: fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/),
      bytes: fc.uint8Array({ maxLength: 512 }),
      executable: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(generatedFile, {
          minLength: 1,
          maxLength: 5,
          selector: (file) => file.name,
        }),
        async (generated) => {
          const root = await mkdtemp(join(tmpdir(), "ccm-archive-property-"));
          try {
            const source = join(root, "source");
            const extracted = join(root, "extracted");
            const archive = join(root, "archive.tar.gz");
            await mkdir(source);
            const files: FileEntry[] = [];
            for (const file of generated) {
              const sourcePath = join(source, file.name);
              await writeFile(sourcePath, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
              files.push({
                sourcePath,
                relativePath: `codex/rules/${file.name}.bin`,
                isSymlink: false,
              });
            }

            await createArchive(files, archive, { providers: ["codex"] });
            const verified = await extractArchive(archive, extracted);
            expect(verified.files.map((file) => file.path).sort()).toEqual(
              files.map((file) => file.relativePath).sort(),
            );
            for (const file of generated) {
              const extractedPath = join(extracted, `codex/rules/${file.name}.bin`);
              expect(await readFile(extractedPath)).toEqual(Buffer.from(file.bytes));
              expect((await lstat(extractedPath)).mode & 0o777).toBe(
                file.executable ? 0o755 : 0o644,
              );
              expect(
                verified.files.find((entry) => entry.path === `codex/rules/${file.name}.bin`)?.mode,
              ).toBe(file.executable ? 0o755 : 0o644);
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 20, seed: PROPERTY_OPTIONS.seed },
    );
  }, 30_000);
});
