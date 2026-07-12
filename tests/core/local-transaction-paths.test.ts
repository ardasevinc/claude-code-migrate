import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureTransactionWorkspace,
  resolveTransactionMemberPaths,
} from "../../src/core/local-transaction-paths.ts";
import type { TransactionMember } from "../../src/core/transaction-journal.ts";

const transactionId = "txn_0123456789abcdef0123456789abcdef";

function member(overrides: Partial<TransactionMember> = {}): TransactionMember {
  return {
    id: "codex-agents",
    rootCode: "codex-home",
    state: "snapshotted",
    stageRef: "stage-0",
    rollbackRef: "rollback-0",
    targetRef: "AGENTS.md",
    originalKind: "absent",
    preimageFingerprint: `fp_${"a".repeat(64)}`,
    postimageFingerprint: `fp_${"b".repeat(64)}`,
    backupRef: "1783900000000",
    ...overrides,
  };
}

describe("local transaction paths", () => {
  it("places material in a private workspace outside managed roots", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "ccm-transaction-paths-")));
    try {
      const root = { code: "codex-home", path: join(home, ".codex") };
      const workspace = await ensureTransactionWorkspace(root.path, transactionId);
      const paths = resolveTransactionMemberPaths(
        new Map([[root.code, root]]),
        transactionId,
        member(),
      );
      expect(workspace).toBe(join(home, ".ccm-transaction-0123456789abcdef0123456789abcdef"));
      expect(paths.target).toBe(join(home, ".codex", "AGENTS.md"));
      expect(paths.stage.startsWith(`${workspace}/`)).toBe(true);
      expect(paths.stage.startsWith(`${root.path}/`)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
