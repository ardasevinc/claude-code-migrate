import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
  armFault,
  bunExecutable,
  createFakeMachine,
  faultMarker,
  readCommandLog,
  runCommand,
} from "./harness/index.ts";

describe("fake-machine integration harness", () => {
  it("isolates machine directories and puts the command shims first", async () => {
    const machine = await createFakeMachine();
    try {
      expect(machine.env.HOME).toBe(machine.home);
      expect(machine.env.TMPDIR).toBe(machine.tmpDir);
      expect(machine.env.XDG_CONFIG_HOME).toBe(machine.xdgConfigHome);
      expect(machine.env.XDG_CACHE_HOME).toBe(machine.xdgCacheHome);
      expect(machine.env.XDG_DATA_HOME).toBe(machine.xdgDataHome);
      expect(machine.env.XDG_STATE_HOME).toBe(machine.xdgStateHome);
      expect(machine.env.PATH?.split(delimiter)[0]).toBe(machine.shimDir);
      expect(machine.env.CCM_TEST_BUN).toBe(bunExecutable);
    } finally {
      await machine.dispose();
    }
  });

  it("routes thin shims through one append-only log and consumes one-shot faults", async () => {
    const machine = await createFakeMachine();
    try {
      const version = await runCommand("codex", ["--version"], machine);
      expect(version).toMatchObject({ exitCode: 0, stderr: "" });
      expect(version.stdout).toContain("fake");

      await armFault(machine, "codex:plugin", {
        exitCode: 42,
        stderr: "injected plugin fault\n",
      });
      const failed = await runCommand("codex", ["plugin", "list"], machine);
      const recovered = await runCommand("codex", ["plugin", "list"], machine);
      expect(failed).toMatchObject({ exitCode: 42, stderr: "injected plugin fault\n" });
      expect(recovered.exitCode).toBe(0);
      await expect(access(faultMarker(machine, "codex:plugin"))).rejects.toThrow();

      expect(await readCommandLog(machine)).toEqual([
        expect.objectContaining({ command: "codex", args: ["--version"], home: machine.home }),
        expect.objectContaining({
          command: "codex",
          args: ["plugin", "list"],
          home: machine.home,
        }),
        expect.objectContaining({
          command: "codex",
          args: ["plugin", "list"],
          home: machine.home,
        }),
      ]);
    } finally {
      await machine.dispose();
    }
  });

  it("executes fake SSH commands against the isolated remote home", async () => {
    const machine = await createFakeMachine();
    try {
      const result = await runCommand(
        "ssh",
        ["operator@example.test", "printf '%s' \"$HOME\""],
        machine,
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: machine.remoteHome, stderr: "" });
      expect(await readCommandLog(machine)).toEqual([
        expect.objectContaining({ command: "ssh", home: machine.home }),
      ]);
    } finally {
      await machine.dispose();
    }
  });
});
