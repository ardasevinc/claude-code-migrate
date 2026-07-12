import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";
import { createArchive } from "../../src/core/archiver.ts";
import { planRestore } from "../../src/core/plan-restore.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import type { FileEntry, ProviderName } from "../../src/types/index.ts";

async function archiveFixture(
  root: string,
  files: Array<[string, string]>,
  providers: ProviderName[],
): Promise<string> {
  const entries: FileEntry[] = [];
  for (const [relativePath, content] of files) {
    const source = join(root, `source-${entries.length}`);
    await writeFile(source, content);
    entries.push({ sourcePath: source, relativePath, isSymlink: false });
  }
  const archive = join(root, "input.tar.gz");
  await createArchive(entries, archive, { providers });
  return archive;
}

describe("planRestore", () => {
  it("plans canonical uppercase and .ccm members without writes or path disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-restore-"));
    try {
      const home = join(root, "home");
      await mkdir(home);
      const archive = await archiveFixture(
        root,
        [
          ["claude/CLAUDE.md", "claude\n"],
          ["codex/AGENTS.md", "codex\n"],
          ["codex/config.toml", 'model = "gpt"\n'],
          ["codex/.ccm/marketplaces/local/plugin.json", "{}\n"],
        ],
        ["claude", "codex"],
      );
      const context = createRuntimeContext({ home, now: () => new Date("2026-01-01T00:00:00Z") });
      const input = { archivePath: archive, context, paths: collectionPathsForHome(home) };
      const first = await planRestore(input);
      const second = await planRestore(input);
      expect(first.plan.id).toBe(second.plan.id);
      expect(first.plan.actions.map((action) => action.scope)).toEqual([
        "codex",
        "claude",
        "codex",
        "codex",
        "codex",
      ]);
      expect(
        first.plan.actions.every(
          (action) =>
            /^restore-target-[a-f0-9]{64}$/.test(action.targetRef) &&
            (action.sourceRef === undefined ||
              /^restore-source-[a-f0-9]{64}$/.test(action.sourceRef)),
        ),
      ).toBe(true);
      expect(JSON.stringify(first)).not.toContain(root);
      expect(await readFile(archive)).toBeTruthy();
      await expect(readFile(join(home, ".codex", "AGENTS.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a noop when a selected provider overlay is byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plan-restore-noop-"));
    try {
      const home = join(root, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "AGENTS.md"), "same\n");
      const archive = await archiveFixture(root, [["codex/AGENTS.md", "same\n"]], ["codex"]);
      const planned = await planRestore({
        archivePath: archive,
        provider: "codex",
        context: createRuntimeContext({ home }),
        paths: collectionPathsForHome(home),
        createdAt: "2026-01-01T00:00:00Z",
      });
      expect(planned.plan.status).toBe("noop");
      expect(planned.plan.actions.map((action) => action.disposition)).toEqual(["unchanged"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
