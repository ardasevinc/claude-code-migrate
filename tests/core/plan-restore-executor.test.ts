import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";
import { createArchive } from "../../src/core/archiver.ts";
import {
  executePlannedRestore,
  planRestore,
  RestoreTransformPlanError,
} from "../../src/core/plan-restore.ts";
import { BlockedError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import type { FileEntry, ProviderName } from "../../src/types/index.ts";

async function fixture(
  root: string,
  files: Array<[string, string]>,
  providers: ProviderName[] = ["codex"],
): Promise<string> {
  const entries: FileEntry[] = [];
  for (const [relativePath, content] of files) {
    const sourcePath = join(root, `source-${entries.length}`);
    await writeFile(sourcePath, content);
    entries.push({ sourcePath, relativePath, isSymlink: false });
  }
  const archive = join(root, "restore.tar.gz");
  await createArchive(entries, archive, { providers });
  return archive;
}

async function setup(files: Array<[string, string]>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-planned-executor-")));
  const home = join(root, "home");
  await mkdir(home);
  const archivePath = await fixture(root, files);
  const context = createRuntimeContext({
    home,
    process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
  });
  const planned = await planRestore({
    archivePath,
    provider: "codex",
    context,
    paths: collectionPathsForHome(home),
    createdAt: "2026-01-01T00:00:00Z",
  });
  return { root, home, archivePath, context, planned };
}

describe("executePlannedRestore", () => {
  it.each([
    ["codex/config.toml", "[[[not toml"],
    ["codex/hooks.json", '{"hooks":'],
  ])("attributes malformed incoming %s to restore inputs", async (path, content) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-planned-invalid-input-")));
    try {
      const home = join(root, "home");
      await mkdir(home);
      const archivePath = await fixture(root, [[path, content]]);
      await expect(
        planRestore({
          archivePath,
          provider: "codex",
          context: createRuntimeContext({
            home,
            process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
          }),
          paths: collectionPathsForHome(home),
        }),
      ).rejects.toBeInstanceOf(RestoreTransformPlanError);
      await expect(
        planRestore({
          archivePath,
          provider: "codex",
          context: createRuntimeContext({
            home,
            process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
          }),
          paths: collectionPathsForHome(home),
        }),
      ).rejects.toThrow("Restore inputs are invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes a sealed overlay and preserves excluded history", async () => {
    const state = await setup([["codex/AGENTS.md", "incoming\n"]]);
    try {
      await mkdir(join(state.home, ".codex"), { recursive: true });
      await writeFile(join(state.home, ".codex/history.jsonl"), "LOCAL-HISTORY\n");
      await executePlannedRestore(state.planned);
      expect(await readFile(join(state.home, ".codex/AGENTS.md"), "utf8")).toBe("incoming\n");
      expect(await readFile(join(state.home, ".codex/history.jsonl"), "utf8")).toBe(
        "LOCAL-HISTORY\n",
      );
      const backup = (await readdir(state.home)).find((name) => name.startsWith(".codex.backup-"));
      expect(backup).toBeUndefined();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("backs up only the changed managed group", async () => {
    const state = await setup([["codex/AGENTS.md", "new\n"]]);
    try {
      await mkdir(join(state.home, ".codex"), { recursive: true });
      await writeFile(join(state.home, ".codex/AGENTS.md"), "old\n");
      await writeFile(join(state.home, ".codex/history.jsonl"), "LOCAL-HISTORY\n");
      const planned = await planRestore({
        archivePath: state.archivePath,
        provider: "codex",
        context: state.context,
        paths: collectionPathsForHome(state.home),
      });
      await executePlannedRestore(planned);
      const backup = (await readdir(state.home)).find((name) => name.startsWith(".codex.backup-"));
      expect(await readFile(join(state.home, backup as string, "AGENTS.md"), "utf8")).toBe("old\n");
      await expect(lstat(join(state.home, backup as string, "history.jsonl"))).rejects.toThrow();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("is single-use and rejects forged wrappers", async () => {
    const state = await setup([["codex/AGENTS.md", "incoming\n"]]);
    try {
      await executePlannedRestore(state.planned);
      await expect(executePlannedRestore(state.planned)).rejects.toBeInstanceOf(BlockedError);
      await expect(executePlannedRestore({ plan: state.planned.plan })).rejects.toBeInstanceOf(
        BlockedError,
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("keeps a plan retryable after source drift", async () => {
    const state = await setup([["codex/AGENTS.md", "incoming\n"]]);
    try {
      const original = await readFile(state.archivePath);
      await writeFile(state.archivePath, "changed");
      await expect(executePlannedRestore(state.planned)).rejects.toBeInstanceOf(BlockedError);
      await writeFile(state.archivePath, original);
      await expect(executePlannedRestore(state.planned)).resolves.toBeUndefined();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("performs no backup or write for a true noop", async () => {
    const state = await setup([["codex/AGENTS.md", "same\n"]]);
    try {
      await mkdir(join(state.home, ".codex"), { recursive: true });
      await writeFile(join(state.home, ".codex/AGENTS.md"), "same\n");
      const planned = await planRestore({
        archivePath: state.archivePath,
        provider: "codex",
        context: state.context,
        paths: collectionPathsForHome(state.home),
      });
      expect(planned.plan.status).toBe("noop");
      await executePlannedRestore(planned);
      expect((await readdir(state.home)).filter((name) => name.includes(".backup-"))).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("backs up a replaced local shared-skill subtree and creates only the sealed view", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-planned-symlink-")));
    try {
      const home = join(root, "home");
      await mkdir(join(home, ".claude/skills/example"), { recursive: true });
      await writeFile(join(home, ".claude/skills/example/LOCAL-ONLY"), "recover me\n");
      const archivePath = await fixture(
        root,
        [
          ["claude/CLAUDE.md", "claude\n"],
          ["shared/agents/skills/example/SKILL.md", "shared\n"],
        ],
        ["claude"],
      );
      const context = createRuntimeContext({
        home,
        process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
      });
      const planned = await planRestore({
        archivePath,
        provider: "claude",
        context,
        paths: collectionPathsForHome(home),
      });
      await executePlannedRestore(planned);
      const backup = (await readdir(home)).find((name) => name.startsWith(".claude.backup-"));
      expect(
        await readFile(join(home, backup as string, "skills/example/LOCAL-ONLY"), "utf8"),
      ).toBe("recover me\n");
      expect(await readlink(join(home, ".claude/skills/example"))).toBe(
        join(home, ".agents/skills/example"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically merges Claude files and the shared-skill view without losing private skills", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-planned-claude-overlap-")));
    try {
      const home = join(root, "home");
      await mkdir(join(home, ".claude/skills/private"), { recursive: true });
      await writeFile(join(home, ".claude/skills/private/SKILL.md"), "private\n");
      const archivePath = await fixture(
        root,
        [
          ["claude/CLAUDE.md", "claude\n"],
          ["shared/agents/skills/example/SKILL.md", "shared\n"],
        ],
        ["claude"],
      );
      const context = createRuntimeContext({
        home,
        process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
      });
      const planned = await planRestore({
        archivePath,
        provider: "claude",
        context,
        paths: collectionPathsForHome(home),
      });

      await executePlannedRestore(planned);

      expect(await readFile(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("claude\n");
      expect(await readFile(join(home, ".claude/skills/private/SKILL.md"), "utf8")).toBe(
        "private\n",
      );
      expect(await readlink(join(home, ".claude/skills/example"))).toBe(
        join(home, ".agents/skills/example"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits the standalone Claude MCP merge in the same transaction", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-planned-claude-mcp-")));
    try {
      const home = join(root, "home");
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(
        join(home, ".claude.json"),
        '{"theme":"dark","mcpServers":{"old":{"command":"old"}}}',
      );
      const archivePath = await fixture(
        root,
        [
          ["claude/CLAUDE.md", "claude\n"],
          ["claude/.mcp-config.json", '{"mcpServers":{"new":{"command":"new"}}}'],
        ],
        ["claude"],
      );
      const context = createRuntimeContext({
        home,
        process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
      });
      const planned = await planRestore({
        archivePath,
        provider: "claude",
        context,
        paths: collectionPathsForHome(home),
      });

      await executePlannedRestore(planned);

      expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf8"))).toEqual({
        theme: "dark",
        mcpServers: { old: { command: "old" }, new: { command: "new" } },
      });
      const backup = (await readdir(home)).find((name) => name.startsWith(".claude.json.backup-"));
      expect(JSON.parse(await readFile(join(home, backup as string), "utf8"))).toEqual({
        theme: "dark",
        mcpServers: { old: { command: "old" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only its own backup when post-backup drift blocks execution", async () => {
    const state = await setup([["codex/AGENTS.md", "new\n"]]);
    try {
      await mkdir(join(state.home, ".codex"), { recursive: true });
      await writeFile(join(state.home, ".codex/AGENTS.md"), "old\n");
      for (let index = 1; index <= 5; index += 1)
        await mkdir(join(state.home, `.codex.backup-${index}`));
      const planned = await planRestore({
        archivePath: state.archivePath,
        provider: "codex",
        context: state.context,
        paths: collectionPathsForHome(state.home),
      });
      await expect(
        executePlannedRestore(planned, {
          afterBackup: () => writeFile(join(state.home, ".codex/AGENTS.md"), "drift\n"),
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(
        (await readdir(state.home)).filter((name) => name.startsWith(".codex.backup-")).sort(),
      ).toEqual([
        ".codex.backup-1",
        ".codex.backup-2",
        ".codex.backup-3",
        ".codex.backup-4",
        ".codex.backup-5",
      ]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("never follows a symlink ancestor introduced into a cloned stage", async () => {
    const state = await setup([["codex/rules/incoming.md", "incoming\n"]]);
    try {
      const attacker = join(state.root, "attacker");
      await mkdir(join(state.home, ".codex/rules"), { recursive: true });
      await mkdir(attacker);
      await writeFile(join(attacker, "incoming.md"), "outside\n");
      const planned = await planRestore({
        archivePath: state.archivePath,
        provider: "codex",
        context: state.context,
        paths: collectionPathsForHome(state.home),
      });

      await expect(
        executePlannedRestore(planned, {
          afterStageClone: async (stagePath, logicalBase) => {
            if (logicalBase !== "codex/rules") return;
            await rm(stagePath, { recursive: true, force: true });
            await symlink(attacker, stagePath);
          },
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(await readFile(join(attacker, "incoming.md"), "utf8")).toBe("outside\n");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
