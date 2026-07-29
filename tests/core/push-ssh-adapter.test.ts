import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushObservationRequestIdentity } from "../../src/core/push-observation-request.ts";
import {
  buildIncrementalRsyncArgs,
  createSshPushExecutionAdapter,
  type PushSshTransport,
  parseRsyncTransportMetrics,
} from "../../src/core/push-ssh-adapter.ts";
import { BlockedError, ConnectivityError, ExecutionError } from "../../src/errors.ts";
import { cleanupInterruptResources } from "../../src/utils/interrupt-cleanup.ts";
import { ProcessError, runProcess } from "../../src/utils/process.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function fixture(options: { readonly externalCache?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-ssh-adapter-")));
  roots.push(root);
  const home = join(root, "home");
  const source = join(root, "source");
  const cacheHome = options.externalCache ? join(root, "xdg-cache") : join(home, ".cache");
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
          XDG_CACHE_HOME: cacheHome,
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
    cacheHome,
    source,
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

  it("parses GNU and openrsync payload metrics without guessing malformed output", () => {
    expect(parseRsyncTransportMetrics("Literal data: 1,024 bytes", 4096)).toEqual({
      transferredBytes: 1024,
      reusedBytes: 3072,
    });
    expect(parseRsyncTransportMetrics("Unmatched data: 512 B", 4096)).toEqual({
      transferredBytes: 512,
      reusedBytes: 3584,
    });
    expect(parseRsyncTransportMetrics("Total sent: 99 B", 4096)).toEqual({
      transferredBytes: null,
      reusedBytes: null,
    });
    expect(parseRsyncTransportMetrics("Literal data: 4097 bytes", 4096)).toEqual({
      transferredBytes: null,
      reusedBytes: null,
    });
    expect(
      parseRsyncTransportMetrics(
        "Literal data: 0 bytes\n       7 100%\nLiteral data: 7 bytes\n",
        7,
      ),
    ).toEqual({ transferredBytes: 7, reusedBytes: 0 });
    expect(parseRsyncTransportMetrics("codex/rules/Literal data: 0 bytes\n", 7)).toEqual({
      transferredBytes: null,
      reusedBytes: null,
    });
  });

  it("uses a real rsync link-dest as the previous sealed snapshot", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-real-rsync-")));
    roots.push(root);
    const source = join(root, "source");
    const previous = join(root, "previous");
    const incoming = join(root, "incoming");
    await Promise.all([source, previous, incoming].map((path) => mkdir(path)));
    await Promise.all([
      writeFile(join(source, "unchanged"), "same"),
      writeFile(join(source, "changed"), "before"),
      writeFile(join(source, ".ccm-manifest.json"), "descriptor bytes are not transport payload"),
    ]);
    const initial = await runProcess("rsync", buildIncrementalRsyncArgs(source, previous));
    expect(parseRsyncTransportMetrics(initial.stdout, 10)).toEqual({
      transferredBytes: 10,
      reusedBytes: 0,
    });
    expect(await lstat(join(previous, ".ccm-manifest.json")).catch(() => null)).toBeNull();
    await writeFile(join(source, "changed"), "after");
    const delta = await runProcess("rsync", buildIncrementalRsyncArgs(source, incoming, previous));
    expect(parseRsyncTransportMetrics(delta.stdout, 9)).toEqual({
      transferredBytes: 5,
      reusedBytes: 4,
    });
    expect((await stat(join(incoming, "unchanged"))).ino).toBe(
      (await stat(join(previous, "unchanged"))).ino,
    );
    expect((await stat(join(incoming, "changed"))).ino).not.toBe(
      (await stat(join(previous, "changed"))).ino,
    );
  });

  it("keeps archive fallback explicit and refuses unavailable forced rsync", async () => {
    const f = await fixture();
    await expect(
      createSshPushExecutionAdapter({ transport: f.transport, mode: "rsync" }).prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        treePath: f.source,
        snapshotId: "a".repeat(64),
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toThrow("requested but is unavailable");

    const archiveTransport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync") throw new Error("archive mode must not probe rsync");
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        throw new Error("archive mode must not probe local rsync");
      },
    };
    const archiveAdapter = createSshPushExecutionAdapter({
      transport: archiveTransport,
      mode: "archive",
    });
    const session = await archiveAdapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    expect(archiveAdapter.transportMetrics?.()).toEqual({
      transferredBytes: f.archiveSize,
      reusedBytes: 0,
    });
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
    expect(f.uploads.some((path) => path.endsWith("archive.tar.gz"))).toBe(true);
  });

  it("retains archive payload metrics when a later manifest upload fails", async () => {
    const f = await fixture();
    const transport: PushSshTransport = {
      ...f.transport,
      async upload(path, host, remotePath, useRsync) {
        if (remotePath.endsWith("manifest.json")) throw new Error("manifest upload failed");
        await f.transport.upload(path, host, remotePath, useRsync);
      },
    };
    const adapter = createSshPushExecutionAdapter({ transport, mode: "archive" });

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
    ).rejects.toThrow("Remote push upload failed");
    expect(adapter.transportMetrics?.()).toEqual({
      transferredBytes: f.archiveSize,
      reusedBytes: 0,
    });
  });

  it("imports a sealed incremental tree without uploading the archive", async () => {
    const f = await fixture({ externalCache: true });
    let syncCalls = 0;
    const linkDests: Array<string | undefined> = [];
    const transport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync")
          return { stdout: "/usr/bin/rsync\n", stderr: "", exitCode: 0, signal: null };
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        return true;
      },
      async syncTree(localTree, _host, remoteDirectory, options) {
        syncCalls += 1;
        linkDests.push(options?.linkDest);
        await cp(localTree, remoteDirectory, { recursive: true, force: true });
        return options?.linkDest
          ? { transferredBytes: 5, reusedBytes: 0 }
          : { transferredBytes: 3, reusedBytes: 0 };
      },
    };
    const adapter = createSshPushExecutionAdapter({ transport, mode: "rsync" });
    const session = await adapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      treePath: f.source,
      snapshotId: "a".repeat(64),
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    expect(adapter.transportMetrics?.()).toEqual({ transferredBytes: 3, reusedBytes: 0 });
    await session.apply(f.action, f.binding);
    await session.commit();
    await session.verifyCommit();
    await session.cleanup();
    expect(f.uploads.some((path) => path.endsWith("archive.tar.gz"))).toBe(false);
    expect(await readFile(join(f.home, ".codex/rules/incoming.md"), "utf8")).toBe("new");
    const snapshotId = "a".repeat(64);
    expect(await lstat(join(f.cacheHome, "ccm/staging/v1/ready", snapshotId))).toBeTruthy();
    expect(
      await lstat(join(f.cacheHome, "ccm/staging/v1/incoming", snapshotId)).catch(() => null),
    ).toBeNull();
    const current = await createSshPushExecutionAdapter({ transport, mode: "rsync" }).observe(
      f.request,
    );
    const repeatedAdapter = createSshPushExecutionAdapter({ transport, mode: "rsync" });
    const repeated = await repeatedAdapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      treePath: f.source,
      snapshotId,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: current,
      actions: [{ action: f.action, binding: f.binding }],
    });
    expect(repeatedAdapter.transportMetrics?.()).toEqual({ transferredBytes: 0, reusedBytes: 3 });
    await repeated.abort();
    await repeated.verifyRollback();
    await repeated.cleanup();
    expect(syncCalls).toBe(1);
    expect(f.uploads.some((path) => path.endsWith("archive.tar.gz"))).toBe(false);

    await writeFile(join(f.source, "codex/rules/incoming.md"), "newer");
    const changedInventory = [
      {
        path: "codex/rules/incoming.md",
        type: "file" as const,
        mode: 0o644 as const,
        size: 5,
        sha256: createHash("sha256").update("newer").digest("hex"),
      },
    ];
    const changedId = "d".repeat(64);
    const changedAdapter = createSshPushExecutionAdapter({ transport, mode: "rsync" });
    const changed = await changedAdapter.prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      treePath: f.source,
      snapshotId: changedId,
      stagedInventory: changedInventory,
      observationRequest: f.request,
      observation: current,
      actions: [{ action: f.action, binding: f.binding }],
    });
    expect(changedAdapter.transportMetrics?.()).toEqual({
      transferredBytes: 5,
      reusedBytes: 0,
    });
    await changed.apply(f.action, f.binding);
    await changed.commit();
    await changed.verifyCommit();
    await changed.cleanup();
    expect(linkDests).toEqual([undefined, join(f.cacheHome, "ccm/staging/v1/ready", snapshotId)]);
    expect(await readFile(join(f.home, ".codex/rules/incoming.md"), "utf8")).toBe("newer");
  }, 15_000);

  it("imports portable spaces and unicode in sealed incremental paths", async () => {
    const f = await fixture();
    const relativePath = "codex/rules/ü spaced.md";
    await rename(join(f.source, "codex/rules/incoming.md"), join(f.source, relativePath));
    const originalEntry = f.stagedInventory[0];
    if (!originalEntry) throw new Error("missing staged fixture entry");
    const stagedInventory = [{ ...originalEntry, path: relativePath }];
    const transport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync")
          return { stdout: "/usr/bin/rsync\n", stderr: "", exitCode: 0, signal: null };
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        return true;
      },
      async syncTree(localTree, _host, remoteDirectory) {
        await cp(localTree, remoteDirectory, { recursive: true, force: true });
      },
    };
    const session = await createSshPushExecutionAdapter({ transport, mode: "rsync" }).prepare({
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      treePath: f.source,
      snapshotId: "e".repeat(64),
      stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    });
    await session.apply(f.action, f.binding);
    await session.commit();
    await session.verifyCommit();
    await session.cleanup();
    expect(await readFile(join(f.home, ".codex/rules/ü spaced.md"), "utf8")).toBe("new");
  });

  it("preserves an interrupted incoming snapshot for an exact retry", async () => {
    const f = await fixture();
    const snapshotId = "b".repeat(64);
    let interrupt = true;
    const transport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync")
          return { stdout: "/usr/bin/rsync\n", stderr: "", exitCode: 0, signal: null };
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        return true;
      },
      async syncTree(localTree, _host, remoteDirectory) {
        if (interrupt) {
          await writeFile(join(remoteDirectory, ".partial-canary"), "partial");
          throw new ConnectivityError("interrupted rsync");
        }
        await rm(remoteDirectory, { recursive: true, force: true });
        await cp(localTree, remoteDirectory, { recursive: true, force: true });
      },
    };
    const input = {
      archivePath: f.archive,
      archiveSha256: f.sha,
      archiveSize: f.archiveSize,
      treePath: f.source,
      snapshotId,
      stagedInventory: f.stagedInventory,
      observationRequest: f.request,
      observation: f.observation,
      actions: [{ action: f.action, binding: f.binding }],
    };
    await expect(
      createSshPushExecutionAdapter({ transport, mode: "rsync" }).prepare(input),
    ).rejects.toBeInstanceOf(ConnectivityError);
    const incoming = join(f.home, ".cache/ccm/staging/v1/incoming", snapshotId);
    expect(await readFile(join(incoming, ".partial-canary"), "utf8")).toBe("partial");
    interrupt = false;
    const retryAdapter = createSshPushExecutionAdapter({ transport, mode: "rsync" });
    const session = await retryAdapter.prepare(input);
    expect(retryAdapter.transportMetrics?.()).toEqual({
      transferredBytes: null,
      reusedBytes: null,
    });
    await session.abort();
    await session.verifyRollback();
    await session.cleanup();
    expect(await lstat(incoming).catch(() => null)).toBeNull();
    expect(await lstat(join(f.home, ".cache/ccm/staging/v1/ready", snapshotId))).toBeTruthy();
  });

  it("rejects an incremental tree with unsealed extra material before live mutation", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "codex/rules/extra.md"), "not sealed");
    const transport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync")
          return { stdout: "/usr/bin/rsync\n", stderr: "", exitCode: 0, signal: null };
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        return true;
      },
      async syncTree(localTree, _host, remoteDirectory) {
        await cp(localTree, remoteDirectory, { recursive: true, force: true });
      },
    };
    await expect(
      createSshPushExecutionAdapter({ transport, mode: "rsync" }).prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        treePath: f.source,
        snapshotId: "c".repeat(64),
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      }),
    ).rejects.toThrow("incremental snapshot does not match sealed inventory");
    expect(await readFile(join(f.home, ".codex/rules/preserved.md"), "utf8")).toBe("keep");
    expect(await lstat(join(f.home, ".codex/rules/incoming.md")).catch(() => null)).toBeNull();
  });

  it("bounds distinct interrupted incoming snapshots", async () => {
    const f = await fixture();
    const transport: PushSshTransport = {
      ...f.transport,
      async run(host, command, options) {
        if (command === "command -v rsync")
          return { stdout: "/usr/bin/rsync\n", stderr: "", exitCode: 0, signal: null };
        return f.transport.run(host, command, options);
      },
      async hasLocalRsync() {
        return true;
      },
      async syncTree(_localTree, _host, remoteDirectory) {
        await writeFile(join(remoteDirectory, ".partial"), "partial");
        throw new ConnectivityError("interrupted rsync");
      },
    };
    const prepare = (snapshotId: string) =>
      createSshPushExecutionAdapter({ transport, mode: "rsync" }).prepare({
        archivePath: f.archive,
        archiveSha256: f.sha,
        archiveSize: f.archiveSize,
        treePath: f.source,
        snapshotId,
        stagedInventory: f.stagedInventory,
        observationRequest: f.request,
        observation: f.observation,
        actions: [{ action: f.action, binding: f.binding }],
      });
    const results = await Promise.allSettled(
      ["1", "2", "3", "4", "5"].map((marker) => prepare(marker.repeat(64))),
    );
    const errors = results.map((result) =>
      result.status === "rejected" ? result.reason : new Error("prepare unexpectedly succeeded"),
    );
    expect(errors.filter((error) => error instanceof ConnectivityError)).toHaveLength(4);
    expect(errors.filter((error) => error instanceof BlockedError)).toMatchObject([
      { message: expect.stringContaining("retention is full") },
    ]);
    expect(await readdir(join(f.home, ".cache/ccm/staging/v1/incoming"))).toHaveLength(4);
  });

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
  }, 15_000);

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
    await expect(adapter.observe(f.request)).rejects.toMatchObject({
      name: "ExecutionError",
      message: "Remote push observation protocol failed: Invalid push observation envelope",
      exitCode: 5,
    });
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

  it.each([
    ["process timed out after 60000ms"],
    ["output exceeded 67108864 byte buffer limit"],
  ])("reports local observation process failure: %s", async (detail) => {
    const f = await fixture();
    const adapter = createSshPushExecutionAdapter({
      transport: {
        ...f.transport,
        run: async () => {
          throw new ProcessError("ssh", {
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: "SIGTERM",
            error: detail,
          });
        },
      },
    });
    await expect(adapter.observe(f.request)).rejects.toMatchObject({
      name: "ExecutionError",
      message: `Remote push observation failed: ${detail}`,
      exitCode: 5,
    });
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
