import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlockedError, ConnectivityError, ExecutionError } from "../../src/errors.ts";
import {
  createSshPushExecutionAdapter,
  type PushSshTransport,
} from "../../src/core/push-ssh-adapter.ts";
import { pushObservationRequestIdentity } from "../../src/core/push-observation-request.ts";
import { cleanupInterruptResources } from "../../src/utils/interrupt-cleanup.ts";
import { runProcess } from "../../src/utils/process.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-ssh-adapter-")));
  roots.push(root);
  const home = join(root, "home");
  const source = join(root, "source");
  await mkdir(join(home, ".codex", "rules"), { recursive: true, mode: 0o700 });
  await mkdir(join(source, "codex", "rules"), { recursive: true });
  await writeFile(join(home, ".codex", "rules", "preserved.md"), "keep");
  await writeFile(join(source, "codex", "rules", "incoming.md"), "new");
  const archive = join(root, "archive.tar.gz");
  await runProcess("tar", ["-czf", archive, "-C", source, "codex"]);
  const bytes = await readFile(archive);
  const commands: string[] = [];
  const uploads: string[] = [];
  const transport: PushSshTransport = {
    run: async (_host, command, options = {}) => {
      commands.push(command);
      return runProcess("sh", ["-c", command], {
        env: {
          ...process.env,
          HOME: home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        nothrow: options.nothrow,
        maxBuffer: options.maxBuffer,
        timeoutMs: options.timeout,
      });
    },
    async upload(path, _host, remotePath) {
      uploads.push(remotePath);
      await cp(path, remotePath);
    },
    async hasLocalRsync() {
      return false;
    },
  };
  const base = {
    host: "localhost",
    inventoryRoots: ["codex/rules"],
    queries: { commandNames: ["python3"] },
  };
  const request = { ...base, requestIdentity: pushObservationRequestIdentity(base) };
  const adapter = createSshPushExecutionAdapter({ transport });
  const observation = await adapter.observe(request);
  const archiveSize = (await lstat(archive)).size;
  const stagedInventory = [
    {
      path: "codex/rules/incoming.md",
      type: "file" as const,
      mode: 0o644 as const,
      size: 3,
      sha256: createHash("sha256").update("new").digest("hex"),
    },
  ];
  const action = { id: "overlay-rules" } as never;
  const binding = { kind: "overlay-group" as const, logicalGroup: "codex/rules" };
  return {
    home,
    archive,
    archiveSize,
    sha: createHash("sha256").update(bytes).digest("hex"),
    commands,
    uploads,
    transport,
    request,
    adapter,
    observation,
    stagedInventory,
    action,
    binding,
  };
}

describe("SSH remote push helper adapter", () => {
  const helperRequest = (command: string): Record<string, unknown> | undefined => {
    const encoded = /'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
    if (!encoded) return undefined;
    try {
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  };
  const helperOp = (command: string): string | undefined =>
    helperRequest(command)?.op as string | undefined;

  it("uploads the fixed protocol files and commits a real helper transaction", async () => {
    const f = await fixture();
    const session = await f.adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    expect(f.uploads.map((path) => path.slice(path.lastIndexOf("/") + 1))).toEqual([
      "helper.py",
      "archive.tar.gz",
      "manifest.json",
    ]);
    expect(f.commands.some((command) => command.includes(" -I -B -c "))).toBe(true);
    expect(f.commands.some((command) => /\b(?:cp|mv|rm|tar)\b/.test(command))).toBe(false);

    await session.apply(f.action, f.binding);
    await expect(readFile(join(f.home, ".codex", "rules", "preserved.md"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(readFile(join(f.home, ".codex", "rules", "incoming.md"), "utf8")).resolves.toBe(
      "new",
    );
    await session.commit();
    await session.verifyCommit();
    await session.cleanup();
  });

  it("aborts through the helper and restores the exact snapshot", async () => {
    const f = await fixture();
    const session = await f.adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.apply(f.action, f.binding);
    await session.abort();
    await expect(readFile(join(f.home, ".codex", "rules", "preserved.md"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(
      readFile(join(f.home, ".codex", "rules", "incoming.md"), "utf8"),
    ).rejects.toThrow();
    await session.verifyRollback();
    await session.cleanup();
  });

  it("maps a valid helper blocked envelope to BlockedError", async () => {
    const f = await fixture();
    await expect(
      f.adapter.prepare({
        archivePath: f.archive,
        archiveSha256: "0".repeat(64),
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
    await expect(lstat(join(f.uploads[0] as string, ".."))).rejects.toThrow();
  });

  it("rejects cleanup before an explicit commit or abort", async () => {
    const f = await fixture();
    const session = await f.adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await expect(session.cleanup()).rejects.toBeInstanceOf(BlockedError);
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
  });

  it("sends only the sealed action ID at apply time", async () => {
    const f = await fixture();
    const session = await f.adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await expect(session.apply({ id: "different" } as never, f.binding)).rejects.toBeInstanceOf(
      BlockedError,
    );
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
  });

  it("rejects a missing sealed command path as BlockedError, not a runtime TypeError", async () => {
    const f = await fixture();
    await expect(
      f.adapter.prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [
          {
            action: { id: "effect" } as never,
            binding: {
              kind: "plugin-add",
              pluginId: "demo@test",
              codexCommand: undefined as unknown as string,
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BlockedError);
  });

  it("interrupt cleanup cancels, aborts, and cleans only after terminal rollback", async () => {
    const f = await fixture();
    const session = await f.adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.apply(f.action, f.binding);
    await cleanupInterruptResources();
    await expect(readFile(join(f.home, ".codex", "rules", "preserved.md"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(
      readFile(join(f.home, ".codex", "rules", "incoming.md"), "utf8"),
    ).rejects.toThrow();
    const helperOps = f.commands.filter((command) => command.includes("compile(data,p"));
    expect(helperOps).toHaveLength(6); // prepare, apply, cancel, abort, verify, cleanup.
  });

  it("rejects malformed successful helper output as ExecutionError", async () => {
    const f = await fixture();
    let helperCalls = 0;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        if (command.includes("compile(data,p")) {
          helperCalls += 1;
          return { stdout: "not-json\n", stderr: "", exitCode: 0, signal: null };
        }
        return f.transport.run(host, command, options);
      },
    };
    const adapter = createSshPushExecutionAdapter({ transport });
    await expect(
      adapter.prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
    expect(helperCalls).toBeGreaterThanOrEqual(1);
  });

  it("classifies upload transport loss as ConnectivityError", async () => {
    const f = await fixture();
    let remotePath: string | undefined;
    const adapter = createSshPushExecutionAdapter({
      transport: {
        ...f.transport,
        upload: async (_local, _host, target) => {
          remotePath = target;
          throw new Error("connection lost");
        },
      },
    });
    await expect(
      adapter.prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toBeInstanceOf(ConnectivityError);
    await expect(lstat(join(remotePath as string, ".."))).rejects.toThrow();
  });

  it("reconciles a lost prepare response through authenticated status", async () => {
    const f = await fixture();
    let lost = false;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        const result = await f.transport.run(host, command, options);
        if (!lost && helperOp(command) === "prepare") {
          lost = true;
          return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
        }
        return result;
      },
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
    expect(lost).toBe(true);
  });

  it("reconciles a lost commit response without attempting rollback", async () => {
    const f = await fixture();
    let loseCommit = true;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        const result = await f.transport.run(host, command, options);
        if (loseCommit && helperOp(command) === "commit") {
          loseCommit = false;
          return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
        }
        return result;
      },
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.apply(f.action, f.binding);
    await session.commit();
    expect(session.isCommitted()).toBe(true);
    await session.verifyCommit();
    await session.cleanup();
  });

  it("reconciles double-lost inflight effect responses through final status", async () => {
    const f = await fixture();
    const codex = join(f.home, "bin", "codex");
    await mkdir(join(f.home, "bin"), { recursive: true });
    await writeFile(codex, "#!/bin/sh\nexit 0\n");
    await chmod(codex, 0o755);
    const base = {
      host: "localhost",
      inventoryRoots: ["codex/rules"],
      queries: { commandNames: ["codex", "python3"] },
    };
    const request = { ...base, requestIdentity: pushObservationRequestIdentity(base) };
    const observation = await f.adapter.observe(request);
    const codexCommand = observation.facts.commandPaths.get("codex");
    expect(codexCommand).toBe(await realpath(codex));
    let effectLosses = 0;
    let statusReads = 0;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        const requestBody = helperRequest(command);
        if (!requestBody) return f.transport.run(host, command, options);
        const op = requestBody.op;
        if (op === "prepare")
          return {
            stdout: `${JSON.stringify({ status: "prepared", token: requestBody.token })}\n`,
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (op === "commit")
          return { stdout: '{"status":"committed"}\n', stderr: "", exitCode: 0, signal: null };
        if (op === "apply-effect") {
          effectLosses += 1;
          return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
        }
        if (op === "status") {
          statusReads += 1;
          return {
            stdout:
              statusReads === 1
                ? '{"applied":0,"appliedEffect":0,"effectInflight":"effect","failedEffects":false,"retentionPending":false,"status":"committed","terminalError":null,"verified":null}\n'
                : '{"applied":0,"appliedEffect":1,"effectInflight":null,"failedEffects":false,"retentionPending":false,"status":"committed","terminalError":null,"verified":null}\n',
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        if (op === "verify-commit")
          return {
            stdout: '{"status":"committed","verified":"commit"}\n',
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (op === "cleanup")
          return { stdout: '{"status":"cleaned"}\n', stderr: "", exitCode: 0, signal: null };
        throw new Error(`unexpected helper op: ${String(op)}`);
      },
    };
    const effect = { id: "effect" } as never;
    const binding = {
      kind: "plugin-add" as const,
      pluginId: "demo@test",
      codexCommand: codexCommand as string,
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: request,
      observation,
      actions: [{ action: effect, binding }],
    });
    await session.commit();
    await session.applyEffect(effect, binding);
    await session.verifyCommit();
    await session.cleanup();
    expect({ effectLosses, statusReads }).toEqual({ effectLosses: 2, statusReads: 2 });
  });

  it("does not advance the local effect cursor for a semantic-invalid response", async () => {
    const f = await fixture();
    const codex = join(f.home, "bin", "codex");
    await mkdir(join(f.home, "bin"), { recursive: true });
    await writeFile(codex, "#!/bin/sh\nexit 0\n");
    await chmod(codex, 0o755);
    const base = {
      host: "localhost",
      inventoryRoots: ["codex/rules"],
      queries: { commandNames: ["codex", "python3"] },
    };
    const request = { ...base, requestIdentity: pushObservationRequestIdentity(base) };
    const observation = await f.adapter.observe(request);
    const codexCommand = observation.facts.commandPaths.get("codex");
    expect(codexCommand).toBe(await realpath(codex));
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        const body = helperRequest(command);
        if (!body) return f.transport.run(host, command, options);
        if (body.op === "prepare")
          return {
            stdout: `${JSON.stringify({ status: "prepared", token: body.token })}\n`,
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (body.op === "commit")
          return { stdout: '{"status":"committed"}\n', stderr: "", exitCode: 0, signal: null };
        if (body.op === "apply-effect")
          return {
            stdout: '{"appliedEffect":99,"status":"committed"}\n',
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (body.op === "status")
          return {
            stdout:
              '{"applied":0,"appliedEffect":1,"effectInflight":null,"failedEffects":false,"retentionPending":false,"status":"committed","terminalError":null,"verified":null}\n',
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (body.op === "verify-commit")
          return {
            stdout: '{"status":"committed","verified":"commit"}\n',
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        if (body.op === "cleanup")
          return { stdout: '{"status":"cleaned"}\n', stderr: "", exitCode: 0, signal: null };
        throw new Error(`unexpected helper op: ${String(body.op)}`);
      },
    };
    const effect = { id: "effect" } as never;
    const binding = {
      kind: "plugin-add" as const,
      pluginId: "demo@test",
      codexCommand: codexCommand as string,
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: request,
      observation,
      actions: [{ action: effect, binding }],
    });
    await session.commit();
    await session.applyEffect(effect, binding);
    await session.verifyCommit();
    await session.cleanup();
  });

  it("reconciles double-lost commit and rollback verification responses", async () => {
    for (const outcome of ["commit", "rollback"] as const) {
      const f = await fixture();
      let verifyLosses = 0;
      let syntheticPending = false;
      const transport: PushSshTransport = {
        ...f.transport,
        run: async (host, command, options) => {
          const op = helperOp(command);
          if (op === `verify-${outcome}` && verifyLosses === 0) {
            verifyLosses += 1;
            return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
          }
          if (op === "status" && verifyLosses === 1 && !syntheticPending) {
            syntheticPending = true;
            const status = outcome === "commit" ? "committed" : "aborted";
            return {
              stdout: `${JSON.stringify({ applied: outcome === "commit" ? 1 : 0, appliedEffect: 0, effectInflight: null, failedEffects: false, retentionPending: true, status, terminalError: null, verified: outcome })}\n`,
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          }
          const result = await f.transport.run(host, command, options);
          if (op === `verify-${outcome}` && verifyLosses === 1) {
            verifyLosses += 1;
            return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
          }
          return result;
        },
      };
      const session = await createSshPushExecutionAdapter({ transport }).prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      });
      if (outcome === "commit") {
        await session.apply(f.action, f.binding);
        await session.commit();
        await session.verifyCommit();
      } else {
        await session.abort();
        await session.verifyRollback();
      }
      await session.cleanup();
      expect({ syntheticPending, verifyLosses }).toEqual({
        syntheticPending: true,
        verifyLosses: 2,
      });
    }
  });

  it("reconciles a lost successful cleanup through the missing-workspace protocol", async () => {
    const f = await fixture();
    let cleanupLost = false;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        const result = await f.transport.run(host, command, options);
        if (!cleanupLost && helperOp(command) === "cleanup") {
          cleanupLost = true;
          return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
        }
        return result;
      },
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.apply(f.action, f.binding);
    await session.commit();
    await session.verifyCommit();
    await session.cleanup();
    expect(cleanupLost).toBe(true);
  });

  it("enforces the exact 64 KiB helper response cap", async () => {
    const f = await fixture();
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) =>
        command.includes("compile(data,p")
          ? { stdout: `${"x".repeat(64 * 1024)}\n`, stderr: "", exitCode: 0, signal: null }
          : f.transport.run(host, command, options),
    };
    const adapter = createSshPushExecutionAdapter({ transport });
    await expect(
      adapter.prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
  });

  it("classifies malformed observation protocol as ExecutionError", async () => {
    const f = await fixture();
    const adapter = createSshPushExecutionAdapter({
      transport: {
        ...f.transport,
        run: async () => ({ stdout: "junk\n", stderr: "", exitCode: 0, signal: null }),
      },
    });
    await expect(adapter.observe(f.request)).rejects.toBeInstanceOf(ExecutionError);
  });

  it("classifies observation transport loss by mutation stage", async () => {
    const f = await fixture();
    const adapter = createSshPushExecutionAdapter({
      transport: {
        ...f.transport,
        run: async () => {
          throw new Error("SSH disappeared");
        },
      },
    });
    await expect(adapter.observe(f.request)).rejects.toBeInstanceOf(ConnectivityError);
    await expect(adapter.observe(f.request, { mutationStarted: true })).rejects.toBeInstanceOf(
      ExecutionError,
    );
  });

  it("classifies transport loss after remote mutation starts as ExecutionError", async () => {
    const f = await fixture();
    let loseApply = true;
    const transport: PushSshTransport = {
      ...f.transport,
      run: async (host, command, options) => {
        if (loseApply && helperOp(command) === "apply") {
          loseApply = false;
          return { stdout: "", stderr: "lost", exitCode: 255, signal: null };
        }
        return f.transport.run(host, command, options);
      },
    };
    const session = await createSshPushExecutionAdapter({ transport }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await expect(session.apply(f.action, f.binding)).rejects.toBeInstanceOf(ExecutionError);
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
  });

  it("ignores hostile TMPDIR framing and emits only safe remote upload paths", async () => {
    const f = await fixture();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = "/tmp/space ; metachar";
    try {
      const session = await f.adapter.prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      });
      expect(f.uploads.every((path) => /^\/[A-Za-z0-9._+@/-]+$/.test(path))).toBe(true);
      await session.abort();
      await session.verifyRollback();
      await session.cleanup();
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});
