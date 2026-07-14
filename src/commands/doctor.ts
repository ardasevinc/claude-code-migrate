import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { collectionPathsForHome } from "../config/providers.ts";
import { buildRemoteExecutableResolverShell } from "../core/push-observation.ts";
import { createSshSession, type SshSession } from "../core/ssh-session.ts";
import { parseSshTarget } from "../core/ssh-target.ts";
import { inspectPrivateStateLayout } from "../core/transaction-journal.ts";
import { ReportedCliError, UsageError } from "../errors.ts";
import { createRuntimeContext, type RuntimeContext } from "../runtime/context.ts";
import type { Config } from "../types/index.ts";

type DoctorStatus = "ok" | "warning" | "failed";

interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly reasonCode: string;
}

interface DoctorOptions {
  readonly remote?: boolean | string;
  readonly local?: boolean;
  readonly json?: boolean;
}

interface DoctorDependencies {
  readonly createSession: (host: string) => Promise<SshSession>;
  readonly loadConfig: () => Promise<Config>;
}

const defaultDependencies: DoctorDependencies = { createSession: createSshSession, loadConfig };

interface RemoteDoctorResult {
  targetRef: string;
  os: string | null;
  arch: string | null;
  commands: {
    python3: boolean | null;
    rsync: boolean | null;
  };
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  return doctorCommandWithContext(options, createRuntimeContext());
}

export async function doctorCommandWithContext(
  options: DoctorOptions,
  context: RuntimeContext,
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<void> {
  if (options.local && options.remote !== undefined && options.remote !== false) {
    throw new UsageError("Use either --local or --remote, not both");
  }
  const checks: DoctorCheck[] = [];
  let config: Config | undefined;
  try {
    config = await dependencies.loadConfig();
    checks.push(check("config", "ok", "config-valid"));
  } catch {
    checks.push(check("config", "failed", "config-invalid"));
  }
  const paths = collectionPathsForHome(context.home);
  for (const [id, path] of [
    ["provider-claude", paths.claudeDir],
    ["provider-codex", paths.codexDir],
    ["shared-agents", paths.sharedAgentsDir],
  ] as const) {
    let info: Awaited<ReturnType<RuntimeContext["files"]["lstat"]>> | null;
    try {
      info = await context.files.lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") info = null;
      else {
        checks.push(check(id, "failed", "path-unreadable"));
        continue;
      }
    }
    checks.push(
      info?.isDirectory()
        ? check(id, "ok", "directory-present")
        : check(id, "warning", info ? "path-not-directory" : "directory-missing"),
    );
  }
  for (const command of ["ssh", "scp"] as const) {
    checks.push(await inspectLocalExecutable(context, command, true));
  }
  checks.push(await inspectLocalExecutable(context, "rsync", false));
  try {
    checks.push(check("state-root", "ok", await inspectPrivateStateLayout(context)));
  } catch {
    checks.push(check("state-root", "failed", "unsafe-state-directory"));
  }

  let remote: RemoteDoctorResult | undefined;
  const configuredHost = config?.target.host;
  const explicitRemote = options.remote !== undefined && options.remote !== false;
  const host =
    typeof options.remote === "string"
      ? options.remote
      : configuredHost === "user@example.com"
        ? undefined
        : configuredHost;
  if (options.local) {
    checks.push(check("remote-target", "warning", "explicitly-skipped"));
  } else if (explicitRemote || host !== undefined) {
    let validTarget = host !== undefined && host !== "user@example.com";
    try {
      if (validTarget && host !== undefined) parseSshTarget(host);
    } catch {
      validTarget = false;
    }
    if (!validTarget || host === undefined) {
      checks.push(
        check(
          "remote-target",
          "failed",
          host === undefined ? "target-unavailable" : "invalid-target",
        ),
      );
    } else {
      checks.push(check("remote-target", "ok", "target-valid"));
      const result = await inspectRemote(host, dependencies.createSession);
      checks.push(...result.checks);
      remote = result.remote;
    }
  } else {
    checks.push(check("remote-target", "warning", "target-not-configured"));
  }

  const projected = [...checks].sort((left, right) => left.id.localeCompare(right.id));
  const output = {
    schemaVersion: 1,
    kind: "doctor",
    healthy: projected.every((item) => item.status !== "failed"),
    checks: projected,
    ...(remote === undefined ? {} : { remote }),
  } as const;
  if (options.json) console.log(JSON.stringify(output));
  else {
    console.log(output.healthy ? "CCM doctor: healthy" : "CCM doctor: unhealthy");
    for (const item of output.checks)
      console.log(`${item.status.padEnd(7)} ${item.id} (${item.reasonCode})`);
  }
  if (!output.healthy) throw new ReportedCliError(1);
}

async function inspectRemote(
  host: string,
  createSession: DoctorDependencies["createSession"],
): Promise<{
  readonly checks: readonly DoctorCheck[];
  readonly remote: RemoteDoctorResult;
}> {
  const checks: DoctorCheck[] = [];
  const remote: RemoteDoctorResult = {
    targetRef: `endpoint_${createHash("sha256").update(`ccm:doctor-target\0${host}`).digest("hex")}`,
    os: null,
    arch: null,
    commands: { python3: null, rsync: null },
  };
  let session: SshSession | undefined;
  try {
    session = await createSession(host);
    const connection = await session.run("printf ok", {
      nothrow: true,
      timeoutMs: 5_000,
      maxBuffer: 1024,
    });
    if (connection.exitCode !== 0 || connection.stdout !== "ok") {
      checks.push(check("remote-connection", "failed", "connection-failed"));
      return { checks, remote };
    }
    checks.push(check("remote-connection", "ok", "connection-established"));
    const probe = await session.run(buildRemoteDoctorProbe(), {
      nothrow: true,
      timeoutMs: 10_000,
      maxBuffer: 4096,
    });
    const facts = parseRemoteProbe(probe.stdout);
    const observed = probe.exitCode === 0 && facts.valid;
    if (observed) {
      remote.os = facts.os;
      remote.arch = facts.arch;
      remote.commands.python3 = facts.python3;
      remote.commands.rsync = facts.rsync;
    }
    checks.push(
      check(
        "remote-probe",
        observed ? "ok" : "failed",
        observed ? "host-observed" : "probe-failed",
      ),
      check(
        "remote-python3",
        !observed ? "warning" : facts.python3 ? "ok" : "failed",
        !observed ? "not-observed" : facts.python3 ? "command-available" : "command-missing",
      ),
      check(
        "remote-rsync",
        !observed || facts.rsync === null ? "warning" : facts.rsync ? "ok" : "warning",
        !observed || facts.rsync === null
          ? "not-observed"
          : facts.rsync
            ? "command-available"
            : "archive-fallback-only",
      ),
    );
    return { checks, remote };
  } catch {
    checks.push(check("remote-transport", "failed", "transport-failed"));
    return { checks, remote };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        checks.push(check("remote-session-cleanup", "failed", "cleanup-failed"));
      }
    }
  }
}

function parseRemoteProbe(output: string): {
  readonly os: string | null;
  readonly arch: string | null;
  readonly python3: boolean | null;
  readonly rsync: boolean | null;
  readonly valid: boolean;
} {
  const records = new Map<string, string>();
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : [];
  let valid = lines.length === 4;
  for (const line of lines) {
    const match = /^(OS|ARCH|PYTHON3|RSYNC)=([^\r\n]{1,128})$/.exec(line);
    if (!match || records.has(match[1] as string)) {
      valid = false;
      continue;
    }
    records.set(match[1] as string, match[2] as string);
  }
  valid = valid && records.size === 4;
  const os = records.get("OS")?.toLowerCase();
  const arch = records.get("ARCH")?.toLowerCase();
  const osValid = os === "darwin" || os === "linux";
  const archValid = arch === "x86_64" || arch === "arm64" || arch === "aarch64";
  const python3 = records.get("PYTHON3");
  const rsync = records.get("RSYNC");
  valid =
    valid &&
    osValid &&
    archValid &&
    (python3 === "0" || python3 === "1") &&
    (rsync === "0" || rsync === "1" || rsync === "?");
  if (!valid) return { os: null, arch: null, python3: null, rsync: null, valid: false };
  return {
    os: os as "darwin" | "linux",
    arch: arch === "x86_64" ? "x86_64" : "arm64",
    python3: python3 === "1",
    rsync: rsync === "?" ? null : rsync === "1",
    valid: true,
  };
}

function buildRemoteDoctorProbe(): string {
  return `set -eu
home=\${HOME-}; case "$home" in /*) ;; *) exit 41;; esac; case "$home" in *'/../'*|*/..|*/./*|*/.) exit 41;; esac
home=$(cd -P "$home" && pwd -P) || exit 41
${buildRemoteExecutableResolverShell()}
python_path=$(findcmd python3)
python_ok=0
if [ -n "$python_path" ]; then
  python_path=$(resolve "$python_path" 2>/dev/null || true)
  if [ -n "$python_path" ]; then
    python_path=$("$python_path" -I -c 'import os,sys; print(os.path.realpath(sys.executable))' 2>/dev/null || true)
    python_path=$(resolve "$python_path" 2>/dev/null || true)
    [ -n "$python_path" ] && python_ok=1
  fi
fi
rsync_ok=?
if [ "$python_ok" = 1 ]; then
  rsync_path=$(findcmd rsync)
  rsync_path=$(resolve "$rsync_path" 2>/dev/null || true)
  if [ -n "$rsync_path" ]; then rsync_ok=1; else rsync_ok=0; fi
fi
printf 'OS=%s\nARCH=%s\nPYTHON3=%s\nRSYNC=%s\n' "$(uname -s)" "$(uname -m)" "$python_ok" "$rsync_ok"`;
}

function check(id: string, status: DoctorStatus, reasonCode: string): DoctorCheck {
  return { id, status, reasonCode };
}

async function hasExecutable(context: RuntimeContext, name: string): Promise<boolean> {
  for (const directory of (context.process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const info = await context.files.stat(join(directory, name));
      if (!info.isFile()) continue;
      await context.files.access(join(directory, name), constants.X_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "ENOTDIR") throw error;
    }
  }
  return false;
}

async function inspectLocalExecutable(
  context: RuntimeContext,
  name: "ssh" | "scp" | "rsync",
  required: boolean,
): Promise<DoctorCheck> {
  try {
    const available = await hasExecutable(context, name);
    return check(
      `local-${name}`,
      available ? "ok" : required ? "failed" : "warning",
      available ? "command-available" : required ? "command-missing" : "archive-fallback-only",
    );
  } catch {
    return check(`local-${name}`, "failed", "probe-failed");
  }
}
