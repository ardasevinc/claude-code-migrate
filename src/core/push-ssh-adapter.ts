import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BlockedError, ConnectivityError, ExecutionError } from "../errors.ts";
import { registerInterruptCleanup } from "../utils/interrupt-cleanup.ts";
import {
  ProcessError,
  type ProcessResult,
  runInheritedProcess,
  runProcess,
  runStreamingProcess,
} from "../utils/process.ts";
import { shellQuote } from "../utils/shell.ts";
import type { InventoryEntry } from "./inventory.ts";
import { canonicalInventory } from "./inventory.ts";
import type {
  PushActionBinding,
  PushExecutionAdapter,
  PushExecutionObservationRequest,
  PushExecutionSession,
} from "./plan-push.ts";
import {
  observeRemotePushTarget,
  type PushTargetObservation,
  pushStateFingerprint,
} from "./push-observation.ts";
import { pushObservationRequestIdentity } from "./push-observation-request.ts";
import { buildArchiveUploadArgs } from "./ssh.ts";
import { assertSshSessionHost, type SshSession } from "./ssh-session.ts";
import { parseSshTarget } from "./ssh-target.ts";

const HELPER_PATH = fileURLToPath(new URL("./remote-push-helper.py", import.meta.url));
const HELPER_RESPONSE_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface PushSshTransport {
  run(
    host: string,
    command: string,
    options?: { nothrow?: boolean; quiet?: boolean; maxBuffer?: number; timeout?: number },
  ): Promise<ProcessResult>;
  upload(localPath: string, host: string, remotePath: string, useRsync: boolean): Promise<void>;
  hasLocalRsync(): Promise<boolean>;
  syncTree?(
    localTree: string,
    host: string,
    remoteDirectory: string,
    options?: { readonly linkDest?: string; readonly payloadBytes?: number },
    // biome-ignore lint/suspicious/noConfusingVoidType: custom transports may omit optional measurements
  ): Promise<PushTransportMetrics | void>;
}

export interface PushTransportMetrics {
  readonly transferredBytes: number | null;
  readonly reusedBytes: number | null;
}

const defaultTransport: PushSshTransport = {
  run: (host, command, options = {}) =>
    runProcess("ssh", [host, command], {
      nothrow: options.nothrow,
      maxBuffer: options.maxBuffer,
      timeoutMs: options.timeout,
    }),
  async upload(localPath, host, remotePath, useRsync) {
    await runInheritedProcess(
      useRsync ? "rsync" : "scp",
      buildArchiveUploadArgs(localPath, `${host}:${remotePath}`, useRsync),
    );
  },
  async hasLocalRsync() {
    return (await runProcess("which", ["rsync"], { nothrow: true })).exitCode === 0;
  },
  async syncTree(localTree, host, remoteDirectory, options = {}) {
    const result = await runStreamingProcess(
      "rsync",
      buildIncrementalRsyncArgs(localTree, `${host}:${remoteDirectory}`, options.linkDest),
      { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 },
    );
    return parseRsyncTransportMetrics(`${result.stdout}\n${result.stderr}`, options.payloadBytes);
  },
};

function sessionTransport(session: SshSession): PushSshTransport {
  return {
    run: (host, command, options = {}) => {
      assertSshSessionHost(session, host);
      return session.run(command, {
        nothrow: options.nothrow,
        maxBuffer: options.maxBuffer,
        timeoutMs: options.timeout,
      });
    },
    async upload(localPath, host, remotePath, useRsync) {
      assertSshSessionHost(session, host);
      await session.upload(
        useRsync ? "rsync" : "scp",
        buildArchiveUploadArgs(localPath, `${host}:${remotePath}`, useRsync),
      );
    },
    async hasLocalRsync() {
      return (await runProcess("which", ["rsync"], { nothrow: true })).exitCode === 0;
    },
    async syncTree(localTree, host, remoteDirectory, options = {}) {
      assertSshSessionHost(session, host);
      const result = await session.streamRsync(
        buildIncrementalRsyncArgs(localTree, `${host}:${remoteDirectory}`, options.linkDest),
        { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 },
      );
      return parseRsyncTransportMetrics(`${result.stdout}\n${result.stderr}`, options.payloadBytes);
    },
  };
}

export function parseRsyncTransportMetrics(
  output: string,
  payloadBytes: number | undefined,
): PushTransportMetrics {
  const matches = [
    ...output.matchAll(/^(?:Literal data:\s*([0-9,]+) bytes|Unmatched data:\s*([0-9,]+) B)\r?$/gm),
  ];
  const match = matches.at(-1);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || payloadBytes === undefined)
    return { transferredBytes: null, reusedBytes: null };
  const transferredBytes = Number(raw.replaceAll(",", ""));
  if (
    !Number.isSafeInteger(transferredBytes) ||
    transferredBytes < 0 ||
    transferredBytes > payloadBytes
  )
    return { transferredBytes: null, reusedBytes: null };
  return { transferredBytes, reusedBytes: payloadBytes - transferredBytes };
}

export function buildIncrementalRsyncArgs(
  localTree: string,
  remoteDirectory: string,
  linkDest?: string,
): string[] {
  return [
    "--archive",
    "--delete",
    "--partial",
    "--partial-dir=.rsync-partial",
    "--progress",
    "--stats",
    "--exclude=/.ccm-manifest.json",
    ...(linkDest ? [`--link-dest=${linkDest}`] : []),
    `${localTree}/`,
    `${remoteDirectory}/`,
  ];
}

export type PushTransportMode = "auto" | "rsync" | "archive";

type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { [key: string]: Canonical };

function ordered(value: Canonical): Canonical {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}

function canonical(value: Canonical): string {
  return JSON.stringify(ordered(value));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeAbsolute(path: unknown, label: string): string {
  if (typeof path !== "string") throw new BlockedError(`Invalid ${label}`);
  const hasControl = [...path].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    Buffer.byteLength(path) > 4096 ||
    hasControl ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new BlockedError(`Invalid ${label}`);
  return path;
}

function safeLogical(path: unknown): string {
  if (typeof path !== "string") throw new BlockedError("Invalid sealed logical group");
  if (
    !/^(?:claude|codex|shared\/agents)\/[A-Za-z0-9._+@/-]+$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new BlockedError("Invalid sealed logical group");
  return path;
}

function safeWorkspace(path: string): string {
  safeAbsolute(path, "remote push workspace");
  if (!/^\/[A-Za-z0-9._+@/-]+$/.test(path))
    throw new ExecutionError("Remote push workspace is unsafe for SSH transport framing");
  return path;
}

function safeRemoteTransportPath(path: unknown, label: string): string {
  const validated = safeAbsolute(path, label);
  if (!/^\/[A-Za-z0-9._+@/-]+$/.test(validated))
    throw new ExecutionError(`Remote ${label} is unsafe for transport framing`);
  return validated;
}

function bootstrapProgram(): string {
  return [
    "import json,os,stat,tempfile",
    "root=os.path.realpath('/tmp/ccm-'+str(os.geteuid()))",
    "os.makedirs(root,mode=0o700,exist_ok=True)",
    "root_stat=os.lstat(root)",
    "assert stat.S_ISDIR(root_stat.st_mode) and root_stat.st_uid==os.geteuid() and stat.S_IMODE(root_stat.st_mode)&0o077==0",
    "w=os.path.realpath(tempfile.mkdtemp(prefix='ccm-push-',dir=root))",
    "os.chmod(w,0o700)",
    "print(json.dumps({'workspace':w},sort_keys=True,separators=(',',':')))",
  ].join(";");
}

// The launcher opens both workspace and helper without following the final
// component, verifies identity/ownership/mode and hashes the exact bytes it
// executes. The helper independently repeats its runtime checksum verification.
function launcherProgram(): string {
  return [
    "import hashlib,os,stat,sys",
    "interpreter=sys.argv[1]",
    "w=sys.argv[2]",
    "expected=sys.argv[3]",
    "payload=sys.argv[4]",
    "before=os.lstat(w)",
    "wfd=os.open(w,os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0))",
    "current=os.fstat(wfd)",
    "assert stat.S_ISDIR(current.st_mode) and current.st_uid==os.geteuid() and stat.S_IMODE(current.st_mode)&0o077==0",
    "assert (before.st_dev,before.st_ino)==(current.st_dev,current.st_ino)",
    "before=os.stat('helper.py',dir_fd=wfd,follow_symlinks=False)",
    "fd=os.open('helper.py',os.O_RDONLY|getattr(os,'O_NOFOLLOW',0),dir_fd=wfd)",
    "current=os.fstat(fd)",
    "assert stat.S_ISREG(current.st_mode) and current.st_uid==os.geteuid() and (before.st_dev,before.st_ino)==(current.st_dev,current.st_ino)",
    "data=b''.join(iter(lambda:os.read(fd,1048576),b''))",
    "os.close(fd)",
    "os.close(wfd)",
    "assert hashlib.sha256(data).hexdigest()==expected",
    "p=w+'/helper.py'",
    "sys.executable=interpreter",
    "sys.argv=[p,payload]",
    "exec(compile(data,p,'exec'),{'__name__':'__main__','__file__':p})",
  ].join(";");
}

function bootstrapCleanupProgram(): string {
  return [
    "import os,shutil,stat,sys",
    "w=sys.argv[1]",
    "not os.path.lexists(w) and sys.exit(0)",
    "before=os.lstat(w)",
    "fd=os.open(w,os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0))",
    "current=os.fstat(fd)",
    "os.close(fd)",
    "assert stat.S_ISDIR(current.st_mode) and current.st_uid==os.geteuid() and stat.S_IMODE(current.st_mode)&0o077==0",
    "assert (before.st_dev,before.st_ino)==(current.st_dev,current.st_ino)",
    "shutil.rmtree(w)",
  ].join(";");
}

function stagingBootstrapProgram(): string {
  return [
    "import fcntl,json,os,stat,sys",
    "home=sys.argv[1]",
    "snapshot=sys.argv[2]",
    "assert len(snapshot)==64 and all(c in '0123456789abcdef' for c in snapshot)",
    "assert os.path.realpath(home)==home",
    "cache=os.environ.get('XDG_CACHE_HOME')",
    "if not cache or not os.path.isabs(cache): cache=os.path.join(home,'.cache')",
    "os.makedirs(cache,mode=0o700,exist_ok=True)",
    "cache_info=os.lstat(cache)",
    "assert os.path.realpath(cache)==cache and stat.S_ISDIR(cache_info.st_mode) and not stat.S_ISLNK(cache_info.st_mode) and cache_info.st_uid==os.geteuid()",
    "current=cache",
    "parts=['ccm','staging','v1']",
    "for part in parts:",
    " current=os.path.join(current,part)",
    " os.makedirs(current,mode=0o700,exist_ok=True)",
    " info=os.lstat(current)",
    " assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==os.geteuid() and stat.S_IMODE(info.st_mode)&0o077==0",
    "base=current",
    "lock_path=os.path.join(base,'.incoming.lock')",
    "lock_fd=os.open(lock_path,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)",
    "lock_info=os.fstat(lock_fd)",
    "assert stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid==os.geteuid() and stat.S_IMODE(lock_info.st_mode)==0o600",
    "fcntl.flock(lock_fd,fcntl.LOCK_EX)",
    "incoming_root=os.path.join(base,'incoming')",
    "ready_root=os.path.join(base,'ready')",
    "for root in (incoming_root,ready_root):",
    " os.makedirs(root,mode=0o700,exist_ok=True)",
    " info=os.lstat(root)",
    " assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==os.geteuid() and stat.S_IMODE(info.st_mode)&0o077==0",
    "ready=os.path.join(ready_root,snapshot)",
    "sealed=os.path.isdir(ready) and not os.path.islink(ready)",
    "incoming=os.path.join(incoming_root,snapshot)",
    "incoming_names=[]",
    "for name in os.listdir(incoming_root):",
    " assert len(name)==64 and all(c in '0123456789abcdef' for c in name)",
    " path=os.path.join(incoming_root,name)",
    " info=os.lstat(path)",
    " assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==os.geteuid() and stat.S_IMODE(info.st_mode)&0o077==0",
    " incoming_names.append(name)",
    "if not sealed and snapshot not in incoming_names and len(incoming_names)>=4:",
    " print(json.dumps({'error':'incoming-retention-full'},sort_keys=True,separators=(',',':')))",
    " sys.exit(75)",
    "if not sealed: os.makedirs(incoming,mode=0o700,exist_ok=True)",
    "fcntl.flock(lock_fd,fcntl.LOCK_UN)",
    "os.close(lock_fd)",
    "candidates=[]",
    "for name in os.listdir(ready_root):",
    " if len(name)==64 and all(c in '0123456789abcdef' for c in name) and name!=snapshot:",
    "  path=os.path.join(ready_root,name)",
    "  info=os.lstat(path)",
    "  if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode): candidates.append((info.st_mtime_ns,path))",
    "previous=max(candidates)[1] if candidates else None",
    "print(json.dumps({'incoming':ready if sealed else incoming,'previous':previous,'root':base,'sealed':sealed},sort_keys=True,separators=(',',':')))",
  ].join("\n");
}

function canonicalResponse(stdout: string): Record<string, unknown> {
  if (Buffer.byteLength(stdout) > HELPER_RESPONSE_BYTES)
    throw new ExecutionError("Remote push helper response exceeds limit");
  if (!stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n"))
    throw new ExecutionError("Invalid remote push helper response envelope");
  const body = stdout.slice(0, -1);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new ExecutionError("Invalid remote push helper response JSON", { cause: error });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonical(value as Canonical) !== body
  )
    throw new ExecutionError("Remote push helper response is not canonical");
  return value as Record<string, unknown>;
}

function transportError(error: unknown, operation: string, mutationStarted: boolean): Error {
  if (error instanceof ExecutionError) return error;
  if (error instanceof BlockedError || error instanceof ConnectivityError)
    return mutationStarted
      ? new ExecutionError(`${operation}: ${error.message}`, { cause: error })
      : error;
  const detail = error instanceof Error ? error.message : String(error);
  const Type = mutationStarted ? ExecutionError : ConnectivityError;
  return new Type(`${operation}: ${detail}`, { cause: error });
}

function isConnectivityResult(result: ProcessResult): boolean {
  return result.exitCode === 255 || result.exitCode === null || result.error !== undefined;
}

async function runChecked(
  transport: PushSshTransport,
  host: string,
  command: string,
  operation: string,
): Promise<ProcessResult> {
  try {
    const result = await transport.run(host, command, {
      nothrow: true,
      quiet: true,
      maxBuffer: HELPER_RESPONSE_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const Type = isConnectivityResult(result) ? ConnectivityError : ExecutionError;
      throw new Type(`${operation} failed (${result.signal ?? result.exitCode ?? "spawn error"})`);
    }
    return result;
  } catch (error) {
    throw transportError(error, operation, false);
  }
}

function validateObservation(
  request: PushExecutionObservationRequest,
  observation: PushTargetObservation,
): { home: string; pythonPath: string } {
  if (
    request.requestIdentity !== pushObservationRequestIdentity(request) ||
    observation.requestIdentity !== request.requestIdentity ||
    observation.pushStateFingerprint !== pushStateFingerprint(observation)
  )
    throw new BlockedError("Push observation is not the exact validated request result");
  const home = safeAbsolute(observation.facts.home, "remote HOME");
  const pythonPath = observation.facts.commandPaths.get("python3");
  if (!pythonPath || basename(pythonPath).length === 0)
    throw new BlockedError("Remote Python 3 interpreter is unavailable");
  safeAbsolute(pythonPath, "resolved Python path");
  return { home, pythonPath };
}

function manifestAction(input: {
  action: { readonly id: string };
  binding: PushActionBinding;
}): Canonical {
  const { action, binding } = input;
  if (!action.id || Buffer.byteLength(action.id) > 1024)
    throw new BlockedError("Invalid sealed push action ID");
  if (binding.kind === "overlay-group")
    return { id: action.id, kind: binding.kind, logicalGroup: safeLogical(binding.logicalGroup) };
  if (binding.kind === "write-claude-mcp")
    return {
      archiveMember: "claude/.mcp-config.json",
      id: action.id,
      kind: binding.kind,
    };
  if (binding.kind === "symlink-view") {
    const names = [...binding.names];
    if (
      names.length !== new Set(names).size ||
      names.some((name) => !/^[A-Za-z0-9._+@-]+$/.test(name) || name === "." || name === "..")
    )
      throw new BlockedError("Invalid sealed shared skill names");
    return { id: action.id, kind: binding.kind, logicalGroup: "claude/skills", names };
  }
  if (binding.kind === "plugin-add") {
    safeAbsolute(binding.codexCommand, "sealed Codex command");
    if (!binding.pluginId || /[\0\r\n]/.test(binding.pluginId))
      throw new BlockedError("Invalid sealed plugin ID");
    return {
      codexCommand: binding.codexCommand,
      id: action.id,
      kind: binding.kind,
      pluginId: binding.pluginId,
    };
  }
  throw new BlockedError(`Unexpected remote push binding: ${binding.kind}`);
}

export function createSshPushExecutionAdapter(
  options: {
    transport?: PushSshTransport;
    helperPath?: string;
    mode?: PushTransportMode;
    session?: SshSession;
  } = {},
): PushExecutionAdapter {
  if (options.transport && options.session)
    throw new BlockedError("Push adapter accepts either an SSH session or a custom transport");
  const transport =
    options.transport ?? (options.session ? sessionTransport(options.session) : defaultTransport);
  const helperPath = options.helperPath ?? HELPER_PATH;
  const mode = options.mode ?? "auto";
  let transportMetrics: PushTransportMetrics = {
    transferredBytes: null,
    reusedBytes: null,
  };
  if (mode !== "auto" && mode !== "rsync" && mode !== "archive")
    throw new BlockedError("Unknown push transport mode");
  const observe = async (
    request: PushExecutionObservationRequest,
    observeOptions: { readonly mutationStarted?: boolean } = {},
  ) => {
    try {
      return await observeRemotePushTarget({
        host: request.host,
        incoming: [],
        inventoryRoots: request.inventoryRoots,
        queries: request.queries,
        requestIdentity: request.requestIdentity,
        transport: {
          run: async (host, command, probeOptions) => {
            let result: ProcessResult;
            try {
              result = await transport.run(host, command, {
                quiet: true,
                maxBuffer: probeOptions.maxBuffer,
                timeout: probeOptions.timeout,
              });
            } catch (error) {
              throw new ConnectivityError("Remote push observation transport failed", {
                cause: error,
              });
            }
            if (isConnectivityResult(result))
              throw new ConnectivityError("Remote push observation transport failed");
            return result;
          },
        },
      });
    } catch (error) {
      if (!(error instanceof ConnectivityError))
        throw error instanceof ExecutionError
          ? error
          : new ExecutionError("Remote push observation protocol failed", { cause: error });
      throw transportError(
        error,
        "Remote push observation failed",
        observeOptions.mutationStarted === true,
      );
    }
  };
  return {
    observe,
    transportMetrics: () => transportMetrics,
    async prepare(input) {
      transportMetrics = { transferredBytes: null, reusedBytes: null };
      parseSshTarget(input.observationRequest.host);
      const { home, pythonPath } = validateObservation(input.observationRequest, input.observation);
      if (
        !Number.isSafeInteger(input.archiveSize) ||
        input.archiveSize < 0 ||
        input.archiveSize > MAX_ARCHIVE_BYTES
      )
        throw new BlockedError("Push archive size exceeds remote helper limit");
      const localArchive = await lstat(input.archivePath);
      if (!localArchive.isFile() || localArchive.size !== input.archiveSize)
        throw new BlockedError("Staged push archive size changed before upload");
      const inventory: readonly InventoryEntry[] = canonicalInventory(input.stagedInventory);
      const inventoryPaths = new Set(inventory.map((entry) => entry.path));
      const sealed = input.actions.map(manifestAction) as unknown as readonly {
        readonly id: string;
        readonly kind: string;
        readonly logicalGroup?: string;
        readonly archiveMember?: string;
      }[];
      const actions = sealed.filter((action) => action.kind !== "plugin-add");
      const effects = sealed.filter((action) => action.kind === "plugin-add");
      for (const action of actions) {
        if (action.kind === "overlay-group") {
          const logical = action.logicalGroup as string;
          if (
            ![...inventoryPaths].some((path) => path === logical || path.startsWith(`${logical}/`))
          )
            throw new BlockedError("Remote action source is outside staged inventory");
        } else if (
          action.kind === "write-claude-mcp" &&
          !inventoryPaths.has(action.archiveMember as string)
        )
          throw new BlockedError("Claude MCP action source is absent from staged inventory");
      }
      for (const action of input.actions) {
        if (
          action.binding.kind === "plugin-add" &&
          input.observation.facts.commandPaths.get("codex") !== action.binding.codexCommand
        )
          throw new BlockedError("Sealed Codex command differs from the validated observation");
      }

      const host = input.observationRequest.host;
      let rsyncAvailable = false;
      if (mode !== "archive") {
        const [localRsync, remoteRsync] = await Promise.all([
          transport.hasLocalRsync(),
          transport.run(host, "command -v rsync", {
            nothrow: true,
            quiet: true,
            maxBuffer: 1024,
            timeout: HELPER_TIMEOUT_MS,
          }),
        ]);
        if (isConnectivityResult(remoteRsync))
          throw new ConnectivityError("Remote rsync capability probe failed");
        if (remoteRsync.exitCode !== 0 && remoteRsync.exitCode !== 1)
          throw new ExecutionError("Remote rsync capability probe returned an invalid status");
        if (
          remoteRsync.exitCode === 0 &&
          !/^\/[A-Za-z0-9._+@/-]*\/rsync\n$/.test(remoteRsync.stdout)
        )
          throw new ExecutionError("Remote rsync capability probe returned an invalid path");
        rsyncAvailable = localRsync && remoteRsync.exitCode === 0;
      }
      if (mode === "rsync" && !rsyncAvailable)
        throw new BlockedError("Rsync transport was requested but is unavailable");
      const useIncremental = mode !== "archive" && rsyncAvailable;
      if (useIncremental && (!input.treePath || !input.snapshotId || !transport.syncTree))
        throw new BlockedError("Incremental transport requires a sealed staged tree");
      let incomingPath: string | undefined;
      let previousSnapshot: string | undefined;
      let snapshotSealed = false;
      let stagingRoot: string | undefined;
      const payloadBytes = inventory.reduce((total, entry) => total + entry.size, 0);
      if (useIncremental) {
        const stagingCommand = `${shellQuote(pythonPath)} -I -B -c ${shellQuote(stagingBootstrapProgram())} ${shellQuote(home)} ${shellQuote(input.snapshotId as string)}`;
        let staged: ProcessResult;
        try {
          staged = await transport.run(host, stagingCommand, {
            nothrow: true,
            quiet: true,
            maxBuffer: HELPER_RESPONSE_BYTES,
            timeout: HELPER_TIMEOUT_MS,
          });
        } catch (error) {
          throw transportError(error, "Remote incremental staging bootstrap", false);
        }
        if (isConnectivityResult(staged))
          throw new ConnectivityError("Remote incremental staging bootstrap transport failed");
        if (staged.exitCode === 75 && staged.stdout === '{"error":"incoming-retention-full"}\n')
          throw new BlockedError(
            "Incremental incoming retention is full; retry an existing snapshot or remove stale CCM staging",
          );
        if (staged.exitCode !== 0)
          throw new ExecutionError(
            `Remote incremental staging bootstrap failed (${staged.exitCode})`,
          );
        const descriptor = canonicalResponse(staged.stdout);
        if (
          Object.keys(descriptor).length !== 4 ||
          typeof descriptor.incoming !== "string" ||
          typeof descriptor.root !== "string" ||
          typeof descriptor.sealed !== "boolean" ||
          (descriptor.previous !== null && typeof descriptor.previous !== "string")
        )
          throw new ExecutionError("Invalid remote incremental staging descriptor");
        incomingPath = safeRemoteTransportPath(descriptor.incoming, "incoming snapshot");
        stagingRoot = safeRemoteTransportPath(descriptor.root, "staging root");
        previousSnapshot =
          descriptor.previous === null
            ? undefined
            : safeRemoteTransportPath(descriptor.previous, "previous snapshot");
        snapshotSealed = descriptor.sealed;
      }
      let workspace: string;
      try {
        const created = await runChecked(
          transport,
          host,
          `${shellQuote(pythonPath)} -I -B -c ${shellQuote(bootstrapProgram())}`,
          "Remote push workspace bootstrap",
        );
        const descriptor = canonicalResponse(created.stdout);
        if (Object.keys(descriptor).length !== 1 || typeof descriptor.workspace !== "string")
          throw new ExecutionError("Invalid remote push workspace descriptor");
        workspace = safeWorkspace(descriptor.workspace);
      } catch (error) {
        throw transportError(error, "Remote push workspace bootstrap", false);
      }

      let prepareMayHaveMutated = false;
      const cleanupBootstrap = async () => {
        const result = await transport.run(
          host,
          `${shellQuote(pythonPath)} -I -B -c ${shellQuote(bootstrapCleanupProgram())} ${shellQuote(workspace)}`,
          { nothrow: true, quiet: true, maxBuffer: 1024, timeout: HELPER_TIMEOUT_MS },
        );
        if (result.exitCode !== 0 || result.error)
          throw new ConnectivityError("Remote bootstrap workspace cleanup failed");
      };
      let interruptCleanup = cleanupBootstrap;
      const unregisterBootstrap = registerInterruptCleanup(() => interruptCleanup());
      try {
        const helperBytes = await readFile(helperPath);
        const helperSha256 = sha256(helperBytes);
        const token = randomBytes(32).toString("hex");
        const manifest = {
          actions,
          ...(useIncremental
            ? {
                incomingPath: incomingPath as string,
                inventory,
                snapshotId: input.snapshotId as string,
                stagingRoot: stagingRoot as string,
                transport: "rsync",
              }
            : { archiveSha256: input.archiveSha256, transport: "archive" }),
          effects,
          home,
          token,
        } as const;
        const manifestBytes = canonical(manifest as unknown as Canonical);
        if (Buffer.byteLength(manifestBytes) > MAX_MANIFEST_BYTES)
          throw new BlockedError("Remote push manifest exceeds limit");
        const localRoot = await mkdtemp(join("/tmp", "ccm-push-manifest-"));
        const manifestPath = join(localRoot, "manifest.json");
        await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
        try {
          await transport.upload(helperPath, host, join(workspace, "helper.py"), rsyncAvailable);
          if (useIncremental) {
            if (snapshotSealed)
              transportMetrics = { transferredBytes: 0, reusedBytes: payloadBytes };
            else {
              const measured = await transport.syncTree?.(
                input.treePath as string,
                host,
                incomingPath as string,
                {
                  ...(previousSnapshot === undefined ? {} : { linkDest: previousSnapshot }),
                  payloadBytes,
                },
              );
              transportMetrics = measured ?? { transferredBytes: null, reusedBytes: null };
            }
          } else {
            await transport.upload(
              input.archivePath,
              host,
              join(workspace, "archive.tar.gz"),
              rsyncAvailable,
            );
            transportMetrics = { transferredBytes: input.archiveSize, reusedBytes: 0 };
          }
          await transport.upload(
            manifestPath,
            host,
            join(workspace, "manifest.json"),
            rsyncAvailable,
          );
        } catch (error) {
          throw transportError(error, "Remote push upload failed", false);
        } finally {
          await rm(localRoot, { recursive: true, force: true });
        }

        const current = await observe(input.observationRequest);
        if (pushStateFingerprint(current) !== pushStateFingerprint(input.observation))
          throw new BlockedError("Push target changed before remote transaction preparation");

        const baseRequest = { helperSha256, home, pythonPath, token, workspace } as const;
        const invoke = async (
          op:
            | "prepare"
            | "apply"
            | "apply-effect"
            | "acknowledge-failed-effects"
            | "commit"
            | "cancel"
            | "abort"
            | "verify-commit"
            | "verify-rollback"
            | "status"
            | "discard"
            | "cleanup",
          extra: Record<string, Canonical> = {},
          mutationStarted = true,
          launcherWorkspace = workspace,
        ): Promise<Record<string, unknown>> => {
          const request = { ...baseRequest, ...extra, op } as unknown as Canonical;
          const payload = Buffer.from(canonical(request)).toString("base64");
          const command = `${shellQuote(pythonPath)} -I -B -c ${shellQuote(launcherProgram())} ${shellQuote(pythonPath)} ${shellQuote(launcherWorkspace)} ${shellQuote(helperSha256)} ${shellQuote(payload)}`;
          let result: ProcessResult;
          try {
            result = await transport.run(host, command, {
              nothrow: true,
              quiet: true,
              maxBuffer: HELPER_RESPONSE_BYTES,
              timeout: HELPER_TIMEOUT_MS,
            });
          } catch (error) {
            throw transportError(error, `Remote push helper ${op}`, mutationStarted);
          }
          if (isConnectivityResult(result))
            throw transportError(
              new ConnectivityError(`Remote push helper ${op} transport failed`, {
                cause: new ProcessError("ssh", result),
              }),
              `Remote push helper ${op}`,
              mutationStarted,
            );
          let response: Record<string, unknown>;
          try {
            response = canonicalResponse(result.stdout);
          } catch (error) {
            throw new ExecutionError(`Remote push helper ${op} returned an invalid response`, {
              cause: error,
            });
          }
          if (
            result.exitCode === 64 &&
            response.error === "blocked" &&
            typeof response.message === "string"
          )
            throw transportError(
              new BlockedError(response.message),
              `Remote push helper ${op}`,
              mutationStarted,
            );
          if (
            result.exitCode === 70 &&
            (response.error === "cancelled" || response.error === "execution") &&
            typeof response.message === "string"
          )
            throw new ExecutionError(response.message);
          if (result.exitCode !== 0)
            throw new ExecutionError(`Remote push helper ${op} failed (${result.exitCode})`);
          if ("error" in response)
            throw new ExecutionError(`Remote push helper ${op} returned an error on success`);
          return response;
        };

        const recoverCleanup = async () => {
          let recoveryWorkspace: string | undefined;
          try {
            const created = await runChecked(
              transport,
              host,
              `${shellQuote(pythonPath)} -I -B -c ${shellQuote(bootstrapProgram())}`,
              "Remote cleanup recovery bootstrap",
            );
            const descriptor = canonicalResponse(created.stdout);
            if (Object.keys(descriptor).length !== 1 || typeof descriptor.workspace !== "string")
              throw new ExecutionError("Invalid cleanup recovery workspace descriptor");
            recoveryWorkspace = safeWorkspace(descriptor.workspace);
            await transport.upload(helperPath, host, join(recoveryWorkspace, "helper.py"), false);
            try {
              return await invoke("cleanup", {}, true, recoveryWorkspace);
            } catch {
              return await invoke("cleanup", {}, true, recoveryWorkspace);
            }
          } catch (error) {
            throw transportError(error, "Remote cleanup recovery failed", true);
          } finally {
            if (recoveryWorkspace) {
              await transport.run(
                host,
                `${shellQuote(pythonPath)} -I -B -c ${shellQuote(bootstrapCleanupProgram())} ${shellQuote(recoveryWorkspace)}`,
                { nothrow: true, quiet: true, maxBuffer: 1024, timeout: HELPER_TIMEOUT_MS },
              );
            }
          }
        };
        const createSession = () =>
          new SshPushExecutionSession(
            input.actions
              .filter(({ binding }) => binding.kind !== "plugin-add")
              .map(({ action }) => action.id),
            input.actions
              .filter(({ binding }) => binding.kind === "plugin-add")
              .map(({ action }) => action.id),
            invoke,
            recoverCleanup,
            async () => {
              const restored = await observe(input.observationRequest, { mutationStarted: true });
              if (pushStateFingerprint(restored) !== pushStateFingerprint(input.observation))
                throw new ExecutionError("Rollback did not restore the planned target state");
            },
          );
        interruptCleanup = async () => {
          try {
            const status = await invoke("status");
            if (status.status !== "prepared") return;
            try {
              await invoke("cancel");
            } catch {
              // Abort reconciles cancellation races.
            }
            const aborted = await invoke("abort");
            if (aborted.status !== "aborted" && aborted.status !== "cancelled") return;
            const restored = await observe(input.observationRequest, { mutationStarted: true });
            if (pushStateFingerprint(restored) !== pushStateFingerprint(input.observation)) return;
            await invoke("verify-rollback");
            await invoke("cleanup");
          } catch {
            try {
              const discarded = await invoke("discard", {}, false);
              if (discarded.status !== "discarded") return;
            } catch {
              // Authenticated evidence remains available for a later recovery retry.
            }
          }
        };
        let prepared: Record<string, unknown>;
        try {
          prepareMayHaveMutated = true;
          prepared = await invoke("prepare", { manifestSha256: sha256(manifestBytes) });
          if (prepared.status !== "prepared" || prepared.token !== token)
            throw new ExecutionError("Remote push helper returned an invalid prepare response");
        } catch (error) {
          try {
            const status = await invoke("status");
            if (status.status === "prepared") {
              unregisterBootstrap();
              return createSession();
            }
            throw new ExecutionError(
              `Unexpected recovered prepare status: ${String(status.status)}`,
            );
          } catch (recoveryError) {
            try {
              const discarded = await invoke("discard", {}, false);
              if (discarded.status === "discarded") prepareMayHaveMutated = false;
            } catch (discardError) {
              throw new ExecutionError("Remote prepare outcome could not be reconciled", {
                cause: new AggregateError([error, recoveryError, discardError]),
              });
            }
            throw error;
          }
        }
        unregisterBootstrap();
        return createSession();
      } catch (error) {
        if (!prepareMayHaveMutated) {
          unregisterBootstrap();
          try {
            await cleanupBootstrap();
          } catch (cleanupError) {
            throw new ExecutionError("Push preparation and workspace cleanup both failed", {
              cause: new AggregateError([error, cleanupError]),
            });
          }
        }
        if (prepareMayHaveMutated)
          throw new ExecutionError("Remote push preparation requires recovery", { cause: error });
        throw error;
      }
    },
  };
}

class SshPushExecutionSession implements PushExecutionSession {
  private next = 0;
  private effectNext = 0;
  private committed = false;
  private rolledBack = false;
  private verified = false;
  private cleaned = false;
  private unregister: () => void;

  constructor(
    private readonly actionIds: readonly string[],
    private readonly effectIds: readonly string[],
    private readonly invoke: (
      op:
        | "prepare"
        | "apply"
        | "apply-effect"
        | "acknowledge-failed-effects"
        | "commit"
        | "cancel"
        | "abort"
        | "verify-commit"
        | "verify-rollback"
        | "status"
        | "discard"
        | "cleanup",
      extra?: Record<string, Canonical>,
      mutationStarted?: boolean,
      launcherWorkspace?: string,
    ) => Promise<Record<string, unknown>>,
    private readonly recoverCleanup: () => Promise<Record<string, unknown>>,
    private readonly verifyOriginalTarget: () => Promise<void>,
  ) {
    this.unregister = registerInterruptCleanup(async () => {
      if (this.committed) return;
      try {
        await this.invoke("cancel");
      } catch {
        // Abort below reconciles cancellation races.
      }
      try {
        const response = await this.invoke("abort");
        this.rolledBack = response.status === "aborted" || response.status === "cancelled";
        if (!this.rolledBack) return;
        await this.verifyOriginalTarget();
        await this.verifyRollback();
        await this.cleanup();
      } catch {
        // Preserve the lock, workspace and retained backups for recovery.
      }
    });
  }

  async apply(action: { readonly id: string }, _binding: PushActionBinding): Promise<void> {
    if (this.committed || this.rolledBack)
      throw new ExecutionError("Remote push transaction is already terminal");
    if (action.id !== this.actionIds[this.next])
      throw new BlockedError("Remote push action is out of sealed order");
    const response = await this.invoke("apply", { actionId: action.id });
    this.next += 1;
    if (response.status !== "prepared" || response.applied !== this.next)
      throw new ExecutionError("Remote push helper returned an invalid apply response");
  }

  async commit(): Promise<void> {
    if (this.committed) return;
    let response: Record<string, unknown>;
    try {
      response = await this.invoke("commit");
    } catch (error) {
      try {
        const status = await this.invoke("status");
        if (status.status === "committed") {
          this.committed = true;
          return;
        }
      } catch (recoveryError) {
        throw new ExecutionError("Remote commit outcome could not be reconciled", {
          cause: new AggregateError([error, recoveryError]),
        });
      }
      throw error;
    }
    if (response.status !== "committed")
      throw new ExecutionError("Remote push helper returned an invalid commit response");
    this.committed = true;
  }

  async applyEffect(action: { readonly id: string }, binding: PushActionBinding): Promise<void> {
    if (!this.committed) throw new BlockedError("Remote effects require a committed transaction");
    if (binding.kind !== "plugin-add" || action.id !== this.effectIds[this.effectNext])
      throw new BlockedError("Remote push effect is out of sealed order");
    const expected = this.effectNext + 1;
    const accept = (response: Record<string, unknown>) => {
      if (response.status !== "committed" || response.appliedEffect !== expected)
        throw new ExecutionError("Remote push helper returned an invalid effect response");
      this.effectNext = expected;
    };
    try {
      accept(await this.invoke("apply-effect", { actionId: action.id }));
    } catch (error) {
      let status: Record<string, unknown>;
      try {
        status = await this.invoke("status");
      } catch (statusError) {
        throw new ExecutionError("committed effect outcome could not be reconciled", {
          cause: new AggregateError([error, statusError]),
        });
      }
      if (status.appliedEffect === expected) {
        this.effectNext = expected;
        return;
      }
      if (status.terminalError)
        throw new ExecutionError("committed_with_failed_effects", { cause: error });
      if (status.effectInflight === action.id) {
        try {
          accept(await this.invoke("apply-effect", { actionId: action.id }));
          return;
        } catch (retryError) {
          try {
            const finalStatus = await this.invoke("status");
            if (finalStatus.appliedEffect === expected) {
              this.effectNext = expected;
              return;
            }
            if (finalStatus.terminalError)
              throw new ExecutionError("committed_with_failed_effects", {
                cause: new AggregateError([error, retryError]),
              });
            throw new ExecutionError("committed effect outcome could not be reconciled", {
              cause: new AggregateError([error, retryError]),
            });
          } catch (finalStatusError) {
            if (
              finalStatusError instanceof ExecutionError &&
              (finalStatusError.message === "committed_with_failed_effects" ||
                finalStatusError.message === "committed effect outcome could not be reconciled")
            )
              throw finalStatusError;
            throw new ExecutionError("committed effect outcome could not be reconciled", {
              cause: new AggregateError([error, retryError, finalStatusError]),
            });
          }
        }
      }
      throw new ExecutionError("committed effect outcome could not be reconciled", {
        cause: error,
      });
    }
  }

  async acknowledgeFailedEffects(): Promise<void> {
    try {
      const response = await this.invoke("acknowledge-failed-effects");
      if (response.status !== "committed_with_failed_effects" || response.failedEffects !== true)
        throw new ExecutionError("Invalid failed-effect acknowledgement response");
    } catch (error) {
      try {
        const status = await this.invoke("status");
        if (status.status === "committed_with_failed_effects" && status.failedEffects === true)
          return;
      } catch (statusError) {
        throw new ExecutionError("Failed-effect acknowledgement could not be reconciled", {
          cause: new AggregateError([error, statusError]),
        });
      }
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.committed || this.rolledBack) return;
    const response = await this.invoke("abort");
    if (response.status !== "aborted" && response.status !== "cancelled")
      throw new ExecutionError("Remote push helper returned an invalid abort response");
    this.rolledBack = true;
  }

  private async reconcileVerification(
    op: "verify-commit" | "verify-rollback",
    verification: "commit" | "rollback",
  ): Promise<void> {
    const validStatus = (status: unknown) =>
      verification === "commit"
        ? status === "committed" || status === "committed_with_failed_effects"
        : status === "aborted" || status === "cancelled";
    const accept = (response: Record<string, unknown>) => {
      if (!validStatus(response.status) || response.verified !== verification)
        throw new ExecutionError(`Remote ${verification} verification acknowledgement failed`);
      if (response.retentionPending === true)
        throw new ExecutionError(
          verification === "commit"
            ? "committed_with_retention_cleanup_pending"
            : "rollback_with_retention_cleanup_pending",
        );
      this.verified = true;
    };
    let firstError: unknown;
    try {
      accept(await this.invoke(op));
      return;
    } catch (error) {
      firstError = error;
    }
    let status: Record<string, unknown>;
    try {
      status = await this.invoke("status");
    } catch (statusError) {
      throw new ExecutionError(`${verification} verification outcome could not be reconciled`, {
        cause: new AggregateError([firstError, statusError]),
      });
    }
    if (status.verified === verification && status.retentionPending === false) {
      this.verified = true;
      return;
    }
    if (status.verified !== verification || status.retentionPending !== true) throw firstError;
    let retryError: unknown;
    try {
      accept(await this.invoke(op));
      return;
    } catch (error) {
      retryError = error;
    }
    try {
      const finalStatus = await this.invoke("status");
      if (finalStatus.verified === verification && finalStatus.retentionPending === false) {
        this.verified = true;
        return;
      }
      throw new ExecutionError(`${verification} verification remains incomplete`);
    } catch (finalStatusError) {
      throw new ExecutionError(`${verification} verification outcome could not be reconciled`, {
        cause: new AggregateError([firstError, retryError, finalStatusError]),
      });
    }
  }

  async verifyCommit(): Promise<void> {
    if (!this.committed) throw new BlockedError("Commit verification requires committed state");
    await this.reconcileVerification("verify-commit", "commit");
  }

  async verifyRollback(): Promise<void> {
    if (!this.rolledBack)
      throw new BlockedError("Rollback verification requires rolled-back state");
    await this.reconcileVerification("verify-rollback", "rollback");
  }

  isCommitted(): boolean {
    return this.committed;
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    if (!this.verified)
      throw new BlockedError("Remote push cleanup requires verified terminal state");
    let response: Record<string, unknown>;
    try {
      response = await this.invoke("cleanup");
    } catch (error) {
      try {
        response = await this.recoverCleanup();
      } catch (recoveryError) {
        throw new ExecutionError("Remote cleanup outcome could not be reconciled", {
          cause: new AggregateError([error, recoveryError]),
        });
      }
    }
    if (response.status !== "cleaned")
      throw new ExecutionError("Remote push helper returned an invalid cleanup response");
    this.cleaned = true;
    this.unregister();
  }
}
