import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintLocalPath } from "../../src/core/local-transaction-fingerprint.ts";

describe("local transaction fingerprints", () => {
  it("distinguishes absence, content, modes, and symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-local-fingerprint-"));
    try {
      const target = join(root, "target");
      const absent = await fingerprintLocalPath(target);
      expect(absent.kind).toBe("absent");
      await writeFile(target, "one", { mode: 0o600 });
      const one = await fingerprintLocalPath(target);
      await writeFile(target, "two", { mode: 0o600 });
      const two = await fingerprintLocalPath(target);
      await chmod(target, 0o700);
      const executable = await fingerprintLocalPath(target);
      await rm(target);
      await symlink("first", target);
      const firstLink = await fingerprintLocalPath(target);
      await rm(target);
      await symlink("second", target);
      const secondLink = await fingerprintLocalPath(target);
      expect(
        new Set([
          absent.fingerprint,
          one.fingerprint,
          two.fingerprint,
          executable.fingerprint,
          firstLink.fingerprint,
          secondLink.fingerprint,
        ]).size,
      ).toBe(6);
      expect(firstLink.kind).toBe("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is independent of directory creation order", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-local-fingerprint-order-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      await mkdir(first);
      await writeFile(join(first, "b"), "b");
      await writeFile(join(first, "a"), "a");
      await mkdir(second);
      await writeFile(join(second, "a"), "a");
      await writeFile(join(second, "b"), "b");
      expect((await fingerprintLocalPath(first)).fingerprint).toBe(
        (await fingerprintLocalPath(second)).fingerprint,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
