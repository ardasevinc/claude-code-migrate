import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readVerifiedArchive } from "../../src/core/archiver.ts";
import { inventoryFromFileEntries } from "../../src/core/inventory.ts";
import { sealPushSourceBindings, stagePushArchive } from "../../src/core/push-staging.ts";

describe("push archive staging", () => {
  it("stages sealed sources with transformed members and cleans up idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-push-staging-test-"));
    try {
      const ordinary = join(root, "ordinary");
      const special = join(root, "special");
      await writeFile(ordinary, "ordinary\n");
      await writeFile(special, "old\n");
      const ordinaryFile = {
        sourcePath: ordinary,
        relativePath: "codex/rules/ordinary.md",
        isSymlink: false,
      };
      const specialFile = {
        sourcePath: special,
        relativePath: "codex/config.toml",
        isSymlink: false,
      };
      const files = [ordinaryFile, specialFile];
      const expectedSourceInventory = await inventoryFromFileEntries(files);
      const transformed = Buffer.from("new\n");
      const expectedStagedInventory = await inventoryFromFileEntries([
        ordinaryFile,
        { ...specialFile, mcpServersOnly: transformed.toString() },
      ]);
      const staged = await stagePushArchive({
        sources: sealPushSourceBindings(files),
        transformedBytes: new Map([["codex/config.toml", transformed]]),
        expectedSourceInventory,
        expectedStagedInventory,
        providers: ["codex"],
        tempRoot: root,
      });
      expect((await readVerifiedArchive(staged.archivePath)).archiveSha256).toBe(
        staged.archiveSha256,
      );
      await staged.cleanup();
      await staged.cleanup();
      expect(await lstat(staged.archivePath).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes residue when a source changes during creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-push-staging-race-test-"));
    try {
      const source = join(root, "source");
      await writeFile(source, "before\n");
      const files = [{ sourcePath: source, relativePath: "codex/config.toml", isSymlink: false }];
      const inventory = await inventoryFromFileEntries(files);
      await expect(
        stagePushArchive({
          sources: sealPushSourceBindings(files),
          transformedBytes: new Map(),
          expectedSourceInventory: inventory,
          expectedStagedInventory: inventory,
          providers: ["codex"],
          tempRoot: root,
          beforePublishTestHook: async () => {
            await writeFile(source, "after\n");
          },
        }),
      ).rejects.toThrow("Push source changed during archive staging");
      expect(await readFile(source, "utf8")).toBe("after\n");
      expect(
        (await import("node:fs/promises"))
          .readdir(root)
          .then((x) => x.filter((n) => n.startsWith("ccm-push-stage-"))),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
