import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeLocalTransaction,
  recoverLocalTransaction,
} from "../../src/core/local-transaction.ts";
import { fingerprintLocalPath } from "../../src/core/local-transaction-fingerprint.ts";
import {
  ensureTransactionWorkspace,
  resolveTransactionMemberPaths,
} from "../../src/core/local-transaction-paths.ts";
import {
  createTransactionJournal,
  listTransactionJournals,
  publishTransactionJournal,
  transitionTransactionJournal,
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

  it.each([
    "journal:planning",
    "materialized:codex-agents",
    "journal:preparing",
    "journal:prepared",
    "journal:committing",
    "renamed:rollback:codex-agents",
    "renamed:commit-unsynced:codex-agents",
    "renamed:commit:codex-agents",
  ])("restores exact pre-state after an injected failure at %s", async (faultBoundary) => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await chmod(target, 0o740);
      const before = await fingerprintLocalPath(target);
      const observed: string[] = [];

      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_fault_matrix",
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
            observed.push(boundary);
            if (boundary === faultBoundary) throw new Error(`injected fault at ${boundary}`);
          },
        }),
      ).rejects.toBeInstanceOf(ExecutionError);

      expect(observed).toContain(faultBoundary);
      expect(await fingerprintLocalPath(target)).toEqual(before);
      expect(await listTransactionJournals(state.context)).toEqual([]);
      expect(
        (await readdir(state.home)).filter(
          (name) => name.startsWith(".ccm-transaction-") || name.startsWith(".codex.backup-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    "journal:planning",
    "materialized:codex-agents",
    "journal:preparing",
    "journal:prepared",
    "journal:committing",
    "renamed:commit-unsynced:codex-agents",
    "renamed:commit:codex-agents",
  ])("restores an absent target after an injected failure at %s", async (faultBoundary) => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      const before = await fingerprintLocalPath(target);

      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_absent_fault_matrix",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n", { mode: 0o750 }),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === faultBoundary) throw new Error(`injected fault at ${boundary}`);
          },
        }),
      ).rejects.toBeInstanceOf(ExecutionError);

      expect(await fingerprintLocalPath(target)).toEqual(before);
      expect(await listTransactionJournals(state.context)).toEqual([]);
      expect(
        (await readdir(state.home)).filter(
          (name) => name.startsWith(".ccm-transaction-") || name.startsWith(".codex.backup-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    "renamed:rollback:codex-agents",
    "renamed:commit-unsynced:codex-agents",
    "renamed:commit:codex-agents",
    "renamed:commit-unsynced:codex-config",
    "renamed:commit:codex-config",
  ])("atomically restores mixed multi-member pre-state after failure at %s", async (faultBoundary) => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const agents = join(codex, "AGENTS.md");
      const instructions = join(codex, "instructions-v1.md");
      const config = join(codex, "config.toml");
      await mkdir(codex);
      await writeFile(instructions, "old agents\n");
      await symlink("instructions-v1.md", agents);
      const beforeAgents = await fingerprintLocalPath(agents);
      const beforeConfig = await fingerprintLocalPath(config);
      const beforeHome = (await readdir(state.home)).sort();
      const beforeCodex = (await readdir(codex)).sort();

      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_multi_member_fault",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new agents\n", { mode: 0o600 }),
            },
            {
              id: "codex-config",
              rootCode: "codex-home",
              targetRef: "config.toml",
              materialize: (stage) => writeFile(stage, "new config\n", { mode: 0o750 }),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === faultBoundary) throw new Error(`injected fault at ${boundary}`);
          },
        }),
      ).rejects.toBeInstanceOf(ExecutionError);

      expect(await fingerprintLocalPath(agents)).toEqual(beforeAgents);
      expect(await fingerprintLocalPath(config)).toEqual(beforeConfig);
      expect((await readdir(state.home)).sort()).toEqual(beforeHome);
      expect((await readdir(codex)).sort()).toEqual(beforeCodex);
      expect(await listTransactionJournals(state.context)).toEqual([]);
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

  it("never overwrites a target recreated after moving the original aside", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_existing_race",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "restored\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === "renamed:rollback:codex-agents")
              await writeFile(target, "external\n", { flag: "wx" });
          },
        }),
      ).rejects.toThrow("requires recovery");
      expect(await readFile(target, "utf8")).toBe("external\n");
      expect((await listTransactionJournals(state.context))[0]?.state).toBe("recovery_required");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    "rollback",
    "accept",
  ] as const)("%s resolves only an exact journaled recovery state", async (mode) => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_recovery_command",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "restored\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === "renamed:rollback:codex-agents")
              await writeFile(target, "external\n", { flag: "wx" });
          },
        }),
      ).rejects.toThrow("requires recovery");
      const pending = (await listTransactionJournals(state.context))[0];
      if (!pending) throw new Error("missing recovery fixture journal");

      await expect(
        recoverLocalTransaction({
          context: state.context,
          transactionId: pending.id,
          mode,
          roots: state.roots,
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(await readFile(target, "utf8")).toBe("external\n");

      if (mode === "rollback") await rm(target);
      else await writeFile(target, "restored\n");
      const terminal = await recoverLocalTransaction({
        context: state.context,
        transactionId: pending.id,
        mode,
        roots: state.roots,
      });
      expect(terminal.state).toBe(mode === "rollback" ? "rolled_back" : "committed");
      expect(await readFile(target, "utf8")).toBe(mode === "rollback" ? "old\n" : "restored\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
      if (mode === "accept") {
        const backup = (await readdir(state.home)).find((name) =>
          name.startsWith(".codex.backup-"),
        );
        expect(await readFile(join(state.home, backup as string, "AGENTS.md"), "utf8")).toBe(
          "old\n",
        );
      }
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("binds recovery to the canonical root established during preparation", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_root_binding",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "restored\n"),
            },
          ],
          verify: async () => {},
          afterBoundary: async (boundary) => {
            if (boundary === "renamed:rollback:codex-agents")
              await writeFile(target, "external\n", { flag: "wx" });
          },
        }),
      ).rejects.toThrow("requires recovery");
      const pending = (await listTransactionJournals(state.context))[0];
      if (!pending) throw new Error("missing recovery fixture journal");
      const displaced = join(state.home, ".codex-displaced");
      const other = join(state.home, ".codex-other");
      await rename(codex, displaced);
      await mkdir(other);
      await writeFile(join(other, "AGENTS.md"), "restored\n");
      await symlink(".codex-other", codex);

      await expect(
        recoverLocalTransaction({
          context: state.context,
          transactionId: pending.id,
          mode: "rollback",
          roots: state.roots,
        }),
      ).rejects.toThrow("root changed since preparation");
      expect(await readFile(join(other, "AGENTS.md"), "utf8")).toBe("restored\n");
      expect((await listTransactionJournals(state.context))[0]?.state).toBe("recovery_required");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("rejects unknown recovery modes at the runtime API boundary", async () => {
    const state = await fixture();
    try {
      await expect(
        recoverLocalTransaction({
          context: state.context,
          transactionId: `txn_${"a".repeat(32)}`,
          mode: "typo" as never,
          roots: state.roots,
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(await listTransactionJournals(state.context)).toEqual([]);
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

  it("preserves external drift while aborting a prepared transaction", async () => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");

      await expect(
        executeLocalTransaction({
          context: state.context,
          planId: "plan_drift",
          roots: state.roots,
          members: [
            {
              id: "codex-agents",
              rootCode: "codex-home",
              targetRef: "AGENTS.md",
              materialize: (stage) => writeFile(stage, "new\n"),
            },
          ],
          beforeCommit: async () => {
            await writeFile(target, "external\n");
            throw new BlockedError("target drifted");
          },
          verify: async () => {},
        }),
      ).rejects.toBeInstanceOf(BlockedError);
      expect(await readFile(target, "utf8")).toBe("external\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
      expect((await readdir(state.home)).filter((name) => name.includes(".backup-"))).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it.each([
    "prepared",
    "aborting",
  ] as const)("resumes and finalizes a crashed %s pre-commit abort", async (crashState) => {
    const state = await fixture();
    try {
      const codex = join(state.home, ".codex");
      const target = join(codex, "AGENTS.md");
      await mkdir(codex);
      await writeFile(target, "old\n");
      let journal = createTransactionJournal({
        kind: "restore",
        planId: "plan_crashed_abort",
        now: new Date("2026-07-13T00:00:00.000Z"),
        members: [{ id: "codex-agents", rootCode: "codex-home" }],
      });
      await publishTransactionJournal(state.context, journal, null);
      await ensureTransactionWorkspace(codex, journal.id);
      const pending = journal.members[0];
      const rootBinding = state.roots[0];
      if (!pending || !rootBinding) throw new Error("invalid transaction fixture");
      const provisional = {
        ...pending,
        state: "snapshotted" as const,
        stageRef: "stage-0",
        rollbackRef: "rollback-0",
        targetRef: "AGENTS.md",
        originalKind: "file" as const,
        preimageFingerprint: (await fingerprintLocalPath(target)).fingerprint,
        postimageFingerprint: "",
        backupRef: "1",
      };
      const paths = resolveTransactionMemberPaths(
        new Map([["codex-home", rootBinding]]),
        journal.id,
        { ...provisional, postimageFingerprint: `fp_${"0".repeat(64)}` },
      );
      await writeFile(paths.stage, "new\n");
      const member = {
        ...provisional,
        postimageFingerprint: (await fingerprintLocalPath(paths.stage)).fingerprint,
      };
      let next = transitionTransactionJournal(
        journal,
        "preparing",
        new Date("2026-07-13T00:00:00.001Z"),
        { members: [member] },
      );
      await publishTransactionJournal(state.context, next, journal.revision);
      journal = next;
      next = transitionTransactionJournal(
        journal,
        "prepared",
        new Date("2026-07-13T00:00:00.002Z"),
      );
      await publishTransactionJournal(state.context, next, journal.revision);
      journal = next;
      if (crashState === "aborting") {
        next = transitionTransactionJournal(
          journal,
          "aborting",
          new Date("2026-07-13T00:00:00.003Z"),
        );
        await publishTransactionJournal(state.context, next, journal.revision);
      }

      await executeLocalTransaction({
        context: state.context,
        planId: "plan_after_crash",
        roots: state.roots,
        members: [
          {
            id: "codex-claude",
            rootCode: "codex-home",
            targetRef: "CLAUDE.md",
            materialize: (stage) => writeFile(stage, "after\n"),
          },
        ],
        verify: async () => {},
      });
      expect(await readFile(target, "utf8")).toBe("old\n");
      expect(await readFile(join(codex, "CLAUDE.md"), "utf8")).toBe("after\n");
      expect(await listTransactionJournals(state.context)).toEqual([]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
