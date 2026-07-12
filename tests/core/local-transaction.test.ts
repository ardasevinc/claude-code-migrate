import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLocalTransaction } from "../../src/core/local-transaction.ts";
import { ensureTransactionWorkspace } from "../../src/core/local-transaction-paths.ts";
import {
  createTransactionJournal,
  listTransactionJournals,
  publishTransactionJournal,
} from "../../src/core/transaction-journal.ts";
import { BlockedError, ExecutionError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-local-transaction-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  let now = Date.parse("2026-07-13T00:00:00.000Z");
  const context = createRuntimeContext({
    home,
    now: () => new Date(now++),
    process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
  });
  return {
    root,
    home,
    context,
    roots: [{ code: "codex-home", path: join(home, ".codex") }],
  };
}

describe("local transactions", () => {
  it("commits an existing top-level member, retains its scoped backup, and prunes its journal", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      const journal = await executeLocalTransaction({
        context: state.context,
        planId: "plan_local",
        roots: state.roots,
        members: [
          {
            id: "codex-agents",
            rootCode: "codex-home",
            targetRef: "AGENTS.md",
            materialize: (stage) => writeFile(stage, "new\n", { mode: 0o600 }),
          },
        ],
        verify: async () => {
          expect(await readFile(target, "utf8")).toBe("new\n");
        },
      });
      expect(journal.state).toBe("committed");
      expect(await readFile(target, "utf8")).toBe("new\n");
      const backup = (await readdir(state.home)).find((name) => name.startsWith(".codex.backup-"));
      expect(await readFile(join(state.home, backup as string, "AGENTS.md"), "utf8")).toBe("old\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
      await expect(
        lstat(join(state.home, `.ccm-transaction-${journal.id.slice("txn_".length)}`)),
      ).rejects.toThrow();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("commits an absent provider root as one non-overlapping member", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      await executeLocalTransaction({
        context: state.context,
        planId: "plan_local",
        roots: state.roots,
        members: [
          {
            id: "codex-root",
            rootCode: "codex-home",
            targetRef: ".",
            materialize: async (stage) => {
              await mkdir(stage);
              await writeFile(join(stage, "AGENTS.md"), "new\n");
            },
          },
        ],
        verify: async () => {},
      });
      expect(await readFile(join(codex, "AGENTS.md"), "utf8")).toBe("new\n");
      expect((await readdir(state.home)).some((name) => name.startsWith(".codex.backup-"))).toBe(
        false,
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("restores old state after a fault following the stage-to-live rename", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === "renamed:commit:codex-agents") throw new Error("fault");
          },
        }),
      ).rejects.toBeInstanceOf(ExecutionError);
      expect(await readFile(target, "utf8")).toBe("old\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("never deletes an old target when a prepared stage disappears", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary, journal) => {
            if (boundary !== "journal:prepared") return;
            const workspace = join(
              state.home,
              `.ccm-transaction-${journal.id.slice("txn_".length)}`,
            );
            await rm(join(workspace, "stage-0"));
            throw new Error("lost stage");
          },
        }),
      ).rejects.toBeInstanceOf(ExecutionError);
      expect(await readFile(target, "utf8")).toBe("old\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("preserves an externally created absent target instead of overwriting it", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          verify: async () => {},
          beforeAbsentRename: () => writeFile(target, "external\n"),
        }),
      ).rejects.toBeInstanceOf(ExecutionError);
      expect(await readFile(target, "utf8")).toBe("external\n");
      expect((await listTransactionJournals(state.context))[0]?.state).toBe("recovery_required");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("fails overlapping targets before any live mutation", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      await mkdir(codex);
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "first",
              rootCode: "codex-home",
              targetRef: "skills",
              materialize: (stage) => mkdir(stage),
            },
            {
              id: "second",
              rootCode: "codex-home",
              targetRef: "skills",
              materialize: (stage) => mkdir(stage),
            },
          ],
          verify: async () => {},
        }),
      ).rejects.toBeInstanceOf(ExecutionError);
      await expect(lstat(join(codex, "skills"))).rejects.toThrow();
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects distinct logical roots that alias the same physical tree", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      await mkdir(codex);
      await writeFile(join(codex, "AGENTS.md"), "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: [...state.roots, { code: "alias-home", path: codex }],
          members: [
            {
              id: "first",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "one\n"),
            },
            {
              id: "second",
              rootCode: "alias-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "two\n"),
            },
          ],
          verify: async () => {},
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(await readFile(join(codex, "AGENTS.md"), "utf8")).toBe("old\n");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("auto-aborts a planning journal and its deterministic workspace before new work", async () => {
    const state = await fixture();
    try {
      const stale = createTransactionJournal({
        kind: "restore",
        planId: "plan_stale",
        now: new Date("2026-07-12T00:00:00.000Z"),
        members: [{ id: "stale", rootCode: "codex-home" }],
      });
      await publishTransactionJournal(state.context, stale, null);
      const transactionRoot = state.roots[0];
      if (!transactionRoot) throw new Error("missing transaction root fixture");
      const workspace = await ensureTransactionWorkspace(transactionRoot.path, stale.id);
      await writeFile(join(workspace, "partial-stage"), "partial");
      await mkdir(join(state.home, ".codex"));
      await executeLocalTransaction({
        context: state.context,
        planId: "plan_new",
        roots: state.roots,
        members: [
          {
            id: "new",
            rootCode: "codex-home",
            targetRef: "AGENTS.md",
            materialize: (stage) => writeFile(stage, "new\n"),
          },
        ],
        verify: async () => {},
      });
      await expect(lstat(workspace)).rejects.toThrow();
      expect(await listTransactionJournals(state.context)).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("retains a committed journal when rollback material is missing", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary, journal) => {
            if (boundary !== "renamed:commit:codex-agents") return;
            await rm(
              join(state.home, `.ccm-transaction-${journal.id.slice("txn_".length)}`, "rollback-0"),
            );
          },
        }),
      ).rejects.toThrow("terminal maintenance is pending");
      expect(await readFile(target, "utf8")).toBe("new\n");
      expect((await listTransactionJournals(state.context))[0]?.state).toBe("committed");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked backup root without moving rollback material through it", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      const attacker = join(state.home, "attacker");
      await mkdir(codex);
      await mkdir(attacker);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_local",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary, journal) => {
            if (boundary !== "renamed:commit:codex-agents") return;
            const backupRef = journal.members[0]?.backupRef;
            await symlink(attacker, `${codex}.backup-${backupRef}`);
          },
        }),
      ).rejects.toThrow("terminal maintenance is pending");
      expect(await readdir(attacker)).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("new\n");
      expect((await listTransactionJournals(state.context))[0]?.state).toBe("committed");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("excludes a concurrent local transaction before its materializer runs", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      await mkdir(codex);
      let release = () => {};
      let acquired = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const first = executeLocalTransaction({
        context: state.context,
        planId: "plan_first",
        roots: state.roots,
        members: [
          {
            id: "first",
            rootCode: "codex-home",
            targetRef: "AGENTS.md",
            materialize: async (stage) => {
              await writeFile(stage, "first\n");
              acquired();
              await held;
            },
          },
        ],
        verify: async () => {},
      });
      await started;
      let secondMaterialized = false;
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_second",
          roots: state.roots,
          members: [
            {
              id: "second",
              rootCode: "codex-home",
              targetRef: "CLAUDE.md",
              materialize: async () => {
                secondMaterialized = true;
              },
            },
          ],
          verify: async () => {},
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(secondMaterialized).toBe(false);
      release();
      await first;
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
