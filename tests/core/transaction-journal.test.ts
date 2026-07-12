import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { withAdvisoryFileLock } from "../../src/core/advisory-lock.ts";
import { transactionJournalDir } from "../../src/core/state-paths.ts";
import {
  createTransactionJournal,
  deleteTerminalTransactionJournal,
  isIncompleteTransaction,
  listTransactionJournals,
  parseTransactionJournal,
  publishTransactionJournal,
  readTransactionJournal,
  type TransactionMember,
  transitionTransactionJournal,
} from "../../src/core/transaction-journal.ts";
import { BlockedError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ccm-journal-")));
  return {
    home,
    context: createRuntimeContext({
      home,
      process: { cwd: () => home, env: { XDG_STATE_HOME: join(home, "state") } },
    }),
  };
}

function snapshotted(journal: ReturnType<typeof createTransactionJournal>): TransactionMember[] {
  return journal.members.map((member) => ({
    ...member,
    state: "snapshotted",
    stageRef: `stage-${member.id}`,
    rollbackRef: `rollback-${member.id}`,
  }));
}

describe("transaction journals", () => {
  it("publishes private journals with revision CAS and strict round trips", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "restore",
      planId: "plan_abc",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [{ id: "claude", rootCode: "claude-home" }],
    });
    const path = await publishTransactionJournal(context, journal, null);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(transactionJournalDir(context))).mode & 0o777).toBe(0o700);
    expect(await listTransactionJournals(context)).toEqual([journal]);
    expect(await readTransactionJournal(context, journal.id)).toEqual(journal);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);

    const preparing = transitionTransactionJournal(
      journal,
      "preparing",
      new Date("2026-07-12T12:01:00.000Z"),
    );
    await publishTransactionJournal(context, preparing, 0);
    await expect(publishTransactionJournal(context, preparing, 0)).rejects.toBeInstanceOf(
      BlockedError,
    );
    await expect(publishTransactionJournal(context, journal, null)).rejects.toBeInstanceOf(
      BlockedError,
    );
    expect((await readTransactionJournal(context, journal.id)).state).toBe("preparing");
  });

  it("validates the complete successor under the writer lock", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "restore",
      planId: "plan_original",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [{ id: "claude", rootCode: "claude-home" }],
    });
    await publishTransactionJournal(context, journal, null);
    const forged = parseTransactionJournal(
      JSON.stringify({
        ...journal,
        revision: 1,
        kind: "push",
        planId: "plan_forged",
        state: "committed",
        updatedAt: "2026-07-12T12:01:00.000Z",
        members: journal.members.map((member) => ({
          ...member,
          state: "committed",
          stageRef: "stage-forged",
          rollbackRef: "rollback-forged",
        })),
      }),
    );
    await expect(publishTransactionJournal(context, forged, 0)).rejects.toThrow(
      "not a valid successor",
    );
    expect(await readTransactionJournal(context, journal.id)).toEqual(journal);
  });

  it("uses one immutable validated snapshot across asynchronous publication", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [],
    });
    const mutable = structuredClone(journal);
    const originalId = mutable.id;
    const publishing = publishTransactionJournal(context, mutable, null);
    Reflect.set(mutable, "id", "txn_00000000000000000000000000000000");
    await publishing;
    expect((await readTransactionJournal(context, originalId)).id).toBe(originalId);
    await expect(readTransactionJournal(context, mutable.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces global and member state invariants", () => {
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_abc",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [{ id: "codex", rootCode: "codex-home" }],
    });
    const preparing = transitionTransactionJournal(
      journal,
      "preparing",
      new Date("2026-07-12T12:01:00.000Z"),
      { members: snapshotted(journal) },
    );
    const prepared = transitionTransactionJournal(
      preparing,
      "prepared",
      new Date("2026-07-12T12:02:00.000Z"),
    );
    const committing = transitionTransactionJournal(
      prepared,
      "committing",
      new Date("2026-07-12T12:03:00.000Z"),
    );
    expect(() =>
      transitionTransactionJournal(committing, "committed", new Date("2026-07-12T12:04:00.000Z")),
    ).toThrow("committed journal requires committed members");
    const members = committing.members.map((member) => ({
      ...member,
      state: "committed" as const,
    }));
    const committed = transitionTransactionJournal(
      committing,
      "committed",
      new Date("2026-07-12T12:04:00.000Z"),
      { members },
    );
    expect(isIncompleteTransaction(committed)).toBe(false);
    expect(() =>
      transitionTransactionJournal(committed, "rolling_back", new Date("2026-07-12T12:05:00.000Z")),
    ).toThrow("Invalid transaction transition");
  });

  it("requires explicit recovery errors and can clear them on acceptance", () => {
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [],
    });
    expect(() =>
      transitionTransactionJournal(
        journal,
        "recovery_required",
        new Date("2026-07-12T12:01:00.000Z"),
      ),
    ).toThrow("needs an error code");
    const recovery = transitionTransactionJournal(
      journal,
      "recovery_required",
      new Date("2026-07-12T12:01:00.000Z"),
      { terminalErrorCode: "process-crashed" },
    );
    const accepted = transitionTransactionJournal(
      recovery,
      "committed",
      new Date("2026-07-12T12:02:00.000Z"),
      { terminalErrorCode: null },
    );
    expect(accepted.terminalErrorCode).toBeUndefined();
  });

  it("represents partial preparation rollback without fabricated references", () => {
    const journal = createTransactionJournal({
      kind: "restore",
      planId: "plan_x",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [
        { id: "claude", rootCode: "claude-home" },
        { id: "codex", rootCode: "codex-home" },
      ],
    });
    const preparing = transitionTransactionJournal(
      journal,
      "preparing",
      new Date("2026-07-12T12:01:00.000Z"),
      {
        members: [
          snapshotted(journal)[0] as TransactionMember,
          journal.members[1] as TransactionMember,
        ],
      },
    );
    const rollingBack = transitionTransactionJournal(
      preparing,
      "rolling_back",
      new Date("2026-07-12T12:02:00.000Z"),
      {
        members: [
          preparing.members[0] as TransactionMember,
          { ...(preparing.members[1] as TransactionMember), state: "untouched" },
        ],
      },
    );
    const rolledBack = transitionTransactionJournal(
      rollingBack,
      "rolled_back",
      new Date("2026-07-12T12:03:00.000Z"),
      {
        members: [
          { ...(rollingBack.members[0] as TransactionMember), state: "rolled_back" },
          rollingBack.members[1] as TransactionMember,
        ],
      },
    );
    expect(rolledBack.members.map((member) => member.state)).toEqual(["rolled_back", "untouched"]);
  });

  it("keeps material references immutable and transition timestamps increasing", () => {
    const journal = createTransactionJournal({
      kind: "restore",
      planId: "plan_x",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [{ id: "claude", rootCode: "claude-home" }],
    });
    expect(() =>
      transitionTransactionJournal(journal, "preparing", new Date(journal.updatedAt)),
    ).toThrow("timestamp must increase");
    const preparing = transitionTransactionJournal(
      journal,
      "preparing",
      new Date("2026-07-12T12:01:00.000Z"),
      { members: snapshotted(journal) },
    );
    expect(() =>
      transitionTransactionJournal(preparing, "prepared", new Date("2026-07-12T12:02:00.000Z"), {
        members: preparing.members.map((member) => ({
          ...member,
          rollbackRef: "rollback-replaced",
        })),
      }),
    ).toThrow("material references cannot change");
  });

  it.each([
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"schemaVersion":2}',
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      id: "txn_bad",
      kind: "push",
      planId: "plan_x",
      state: "planning",
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
      members: [],
    }),
  ])("rejects corrupt or non-canonical journal input", (source) => {
    expect(() => parseTransactionJournal(source)).toThrow();
  });

  it("rejects oversized input symmetrically before publication", async () => {
    const { context } = await fixture();
    expect(() =>
      createTransactionJournal({
        kind: "push",
        planId: "plan_x",
        now: new Date("2026-07-12T12:00:00.000Z"),
        members: Array.from({ length: 257 }, (_, index) => ({
          id: `member-${index}`,
          rootCode: "root",
        })),
      }),
    ).toThrow("journal members are invalid");
    expect(await listTransactionJournals(context)).toEqual([]);
  });

  it("caps new journals until a terminal journal is pruned", async () => {
    const { context } = await fixture();
    expect(await listTransactionJournals(context)).toEqual([]);
    const directory = transactionJournalDir(context);
    await Promise.all(
      Array.from({ length: 1024 }, (_, index) =>
        writeFile(join(directory, `placeholder-${index}.json`), "{}", { mode: 0o600 }),
      ),
    );
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date(),
      members: [],
    });
    await expect(publishTransactionJournal(context, journal, null)).rejects.toThrow(
      "retention limit reached",
    );
  });

  it("only prunes terminal journals at the expected revision", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date("2026-07-12T12:00:00.000Z"),
      members: [],
    });
    await publishTransactionJournal(context, journal, null);
    await expect(deleteTerminalTransactionJournal(context, journal.id, 0)).rejects.toThrow(
      "Incomplete transaction journals cannot be deleted",
    );
    const recovery = transitionTransactionJournal(
      journal,
      "recovery_required",
      new Date("2026-07-12T12:01:00.000Z"),
      { terminalErrorCode: "accepted" },
    );
    await publishTransactionJournal(context, recovery, 0);
    const committed = transitionTransactionJournal(
      recovery,
      "committed",
      new Date("2026-07-12T12:02:00.000Z"),
      { terminalErrorCode: null },
    );
    await publishTransactionJournal(context, committed, 1);
    await expect(deleteTerminalTransactionJournal(context, journal.id, 1)).rejects.toThrow(
      "changed concurrently",
    );
    await deleteTerminalTransactionJournal(context, journal.id, 2);
    await expect(readTransactionJournal(context, journal.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects symlinked transaction and CCM state directories before journal writes", async () => {
    for (const rootSymlink of [false, true]) {
      const { context, home } = await fixture();
      const target = join(home, rootSymlink ? "attacker-root" : "attacker-transactions");
      await mkdir(target);
      const directory = transactionJournalDir(context);
      await mkdir(rootSymlink ? dirname(dirname(directory)) : dirname(directory), {
        recursive: true,
      });
      await symlink(target, rootSymlink ? dirname(directory) : directory);
      const journal = createTransactionJournal({
        kind: "push",
        planId: "plan_x",
        now: new Date(),
        members: [],
      });
      await expect(publishTransactionJournal(context, journal, null)).rejects.toThrow(
        "CCM state directory",
      );
      expect(await readdir(target)).toEqual([]);
    }
  });

  it("rejects symlinked XDG state roots", async () => {
    const { context, home } = await fixture();
    const target = join(home, "attacker-xdg");
    await mkdir(target);
    await symlink(target, join(home, "state"));
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date(),
      members: [],
    });
    await expect(publishTransactionJournal(context, journal, null)).rejects.toThrow(
      "XDG state directory",
    );
    expect(await readdir(target)).toEqual([]);
  });

  it("does not populate a nested XDG path through a symlink ancestor", async () => {
    const { home } = await fixture();
    const target = join(home, "attacker-nested-xdg");
    await mkdir(target);
    await symlink(target, join(home, "state-link"));
    const context = createRuntimeContext({
      home,
      process: {
        cwd: () => home,
        env: { XDG_STATE_HOME: join(home, "state-link", "nested") },
      },
    });
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date(),
      members: [],
    });
    await expect(publishTransactionJournal(context, journal, null)).rejects.toThrow(
      "XDG state directory ancestry",
    );
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects unsafe journal file identity, ownership surface, and filename mismatch", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date(),
      members: [],
    });
    const path = await publishTransactionJournal(context, journal, null);
    await chmod(path, 0o644);
    await expect(readTransactionJournal(context, journal.id)).rejects.toThrow(
      "Unsafe transaction journal file",
    );
    await chmod(path, 0o600);
    const wrong = join(dirname(path), "txn_00000000000000000000000000000000.json");
    await writeFile(wrong, await readFile(path));
    await chmod(wrong, 0o600);
    await expect(listTransactionJournals(context)).rejects.toThrow("identity mismatch");
  });

  it("fails a concurrent writer lock before touching journal state", async () => {
    const { context } = await fixture();
    const journal = createTransactionJournal({
      kind: "push",
      planId: "plan_x",
      now: new Date(),
      members: [],
    });
    await publishTransactionJournal(context, journal, null);
    const preparing = transitionTransactionJournal(
      journal,
      "preparing",
      new Date(Date.now() + 1000),
    );
    let releaseLock = () => {};
    let markAcquired = () => {};
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holding = withAdvisoryFileLock(
      join(transactionJournalDir(context), ".writer.lock"),
      async () => {
        markAcquired();
        await release;
      },
    );
    await acquired;
    await expect(publishTransactionJournal(context, preparing, 0)).rejects.toBeInstanceOf(
      BlockedError,
    );
    releaseLock();
    await holding;
    expect((await readTransactionJournal(context, journal.id)).revision).toBe(0);
  });
});
