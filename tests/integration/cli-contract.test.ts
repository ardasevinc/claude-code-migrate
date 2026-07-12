import { describe, expect, it } from "vitest";
import { createFakeMachine, runCcm } from "./harness/index.ts";

describe("CCM subprocess contract", () => {
  it("returns help on stdout with exit 0", async () => {
    const machine = await createFakeMachine();
    try {
      const result = await runCcm(["--help"], machine);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: ccm");
    } finally {
      await machine.dispose();
    }
  });

  it("maps syntax errors to exit 2 and stderr", async () => {
    const machine = await createFakeMachine();
    try {
      const result = await runCcm(["restore"], machine);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing required argument");
    } finally {
      await machine.dispose();
    }
  });

  it("maps an empty backup to blocked exit 3 without stdout diagnostics", async () => {
    const machine = await createFakeMachine();
    try {
      const result = await runCcm(["backup", "codex", "--dry-run"], machine);
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toEqual([
        expect.stringContaining("[codex] Provider directory not found:"),
        "No files to backup",
      ]);
    } finally {
      await machine.dispose();
    }
  });

  it("rejects JSON on mutating backup as usage before filesystem work", async () => {
    const machine = await createFakeMachine();
    try {
      const result = await runCcm(["backup", "codex", "--json"], machine);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("--json currently requires --dry-run");
    } finally {
      await machine.dispose();
    }
  });
});
