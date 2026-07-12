import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverLocalTransaction } from "../../src/core/local-transaction.ts";
import {
  listTransactionJournals,
  publishTransactionJournal,
  transitionTransactionJournal,
} from "../../src/core/transaction-journal.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";
import { bunExecutable } from "../integration/harness/index.ts";

describe("local transaction hard-crash recovery", () => {
  it.each([
    ["journal:committing", "rollback", "old\n", "rolled_back"],
    ["renamed:rollback:codex-agents", "rollback", "old\n", "rolled_back"],
    ["renamed:commit-unsynced:codex-agents", "accept", "new\n", "committed"],
  ] as const)("recovers a SIGKILL at %s through %s", async (boundary, mode, expectedBytes, expectedState) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-transaction-crash-")));
    try {
      const child = spawn(
        bunExecutable,
        ["tests/fixtures/local-transaction-interrupt.ts", root, boundary],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("close", (code) =>
          reject(
            new Error(
              `fixture exited early: ${code}: ${stderr.map((chunk) => chunk.toString()).join("")}`,
            ),
          ),
        );
      });
      child.kill("SIGKILL");
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result).toEqual({ code: null, signal: "SIGKILL" });
      const home = join(root, "home");
      const context = createRuntimeContext({
        home,
        process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
      });
      const journal = (await listTransactionJournals(context))[0];
      if (!journal) throw new Error("hard crash did not retain its transaction journal");
      expect(journal.state).toBe("committing");

      const terminal = await recoverLocalTransaction({
        context,
        transactionId: journal.id,
        mode,
      });

      expect(terminal.state).toBe(expectedState);
      expect(await readFile(join(home, ".codex/AGENTS.md"), "utf8")).toBe(expectedBytes);
      expect(await listTransactionJournals(context)).toEqual([]);
      const homeEntries = await readdir(home);
      expect(homeEntries.filter((name) => name.startsWith(".ccm-transaction-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finalizes untouched members from a crashed planning rollback", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-transaction-untouched-")));
    try {
      const child = spawn(
        bunExecutable,
        ["tests/fixtures/local-transaction-interrupt.ts", root, "journal:planning"],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const home = join(root, "home");
      const context = createRuntimeContext({
        home,
        process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
      });
      const planning = (await listTransactionJournals(context))[0];
      if (!planning) throw new Error("hard crash did not retain its planning journal");
      const rollingBack = transitionTransactionJournal(
        planning,
        "rolling_back",
        new Date(new Date(planning.updatedAt).getTime() + 1),
        {
          members: planning.members.map((member) => ({
            ...member,
            state: "untouched" as const,
          })),
        },
      );
      await publishTransactionJournal(context, rollingBack, planning.revision);

      const terminal = await recoverLocalTransaction({
        context,
        transactionId: rollingBack.id,
        mode: "rollback",
      });

      expect(terminal.state).toBe("rolled_back");
      expect(await readFile(join(home, ".codex/AGENTS.md"), "utf8")).toBe("old\n");
      expect(await listTransactionJournals(context)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
