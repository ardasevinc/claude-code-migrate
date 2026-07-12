import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverCommandWithContext,
  transactionsCommandWithContext,
} from "../../src/commands/transactions.ts";
import {
  createTransactionJournal,
  publishTransactionJournal,
  transitionTransactionJournal,
} from "../../src/core/transaction-journal.ts";
import { UsageError } from "../../src/errors.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-transactions-command-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  return {
    root,
    context: createRuntimeContext({
      home,
      process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
    }),
  };
}

describe("transactions command", () => {
  it("prints one stable JSON object without private material paths or fingerprints", async () => {
    const state = await fixture();
    try {
      let journal = createTransactionJournal({
        kind: "restore",
        planId: "plan_command",
        now: new Date("2026-07-13T00:00:00.000Z"),
        members: [{ id: "codex-agents", rootCode: "codex-home" }],
      });
      await publishTransactionJournal(state.context, journal, null);
      const next = transitionTransactionJournal(
        journal,
        "recovery_required",
        new Date("2026-07-13T00:00:00.001Z"),
        { terminalErrorCode: "operator-action-required" },
      );
      await publishTransactionJournal(state.context, next, journal.revision);
      journal = next;
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => lines.push(String(value)));

      await transactionsCommandWithContext({ json: true }, state.context);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual({
        transactions: [
          {
            id: journal.id,
            kind: "restore",
            planId: "plan_command",
            state: "recovery_required",
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.001Z",
            members: [{ id: "codex-agents", rootCode: "codex-home", state: "pending" }],
            terminalErrorCode: "operator-action-required",
          },
        ],
      });
      expect(lines[0]).not.toContain("fingerprint");
      expect(lines[0]).not.toContain("stage-");
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("prints an explicit empty human state", async () => {
    const state = await fixture();
    try {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => lines.push(String(value)));
      await transactionsCommandWithContext({}, state.context);
      expect(lines).toEqual(["No CCM transactions."]);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });

  it("requires one explicit recovery mode and a canonical transaction ID", async () => {
    const state = await fixture();
    try {
      await expect(
        recoverCommandWithContext("not-a-transaction", { rollback: true }, state.context),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        recoverCommandWithContext(`txn_${"a".repeat(32)}`, {}, state.context),
      ).rejects.toBeInstanceOf(UsageError);
      await expect(
        recoverCommandWithContext(
          `txn_${"a".repeat(32)}`,
          { rollback: true, accept: true },
          state.context,
        ),
      ).rejects.toBeInstanceOf(UsageError);
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
  });
});
