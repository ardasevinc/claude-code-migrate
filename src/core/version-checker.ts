import { log } from "../utils/logger.ts";
import { runProcess } from "../utils/process.ts";
import { assertSshSessionHost, type SshSession } from "./ssh-session.ts";
import { parseSshTarget } from "./ssh-target.ts";

export async function getClaudeVersion(): Promise<string | null> {
  try {
    const result = await runProcess("claude", ["--version"]);
    const output = result.stdout.trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function getRemoteClaudeVersion(
  host: string,
  session?: SshSession,
): Promise<string | null> {
  parseSshTarget(host);
  if (session) assertSshSessionHost(session, host);
  try {
    const result = session
      ? await session.run("claude --version")
      : await runProcess("ssh", [host, "claude --version"]);
    const output = result.stdout.trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (!major || !minor || !patch) return null;
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
  };
}

export async function checkVersionCompatibility(
  host: string,
  session?: SshSession,
): Promise<{ compatible: boolean; warning?: string }> {
  parseSshTarget(host);
  const localVersion = await getClaudeVersion();
  const remoteVersion = await getRemoteClaudeVersion(host, session);

  if (!localVersion) {
    return {
      compatible: true,
      warning: "Could not determine local Claude version",
    };
  }

  if (!remoteVersion) {
    return {
      compatible: true,
      warning: "Could not determine remote Claude version (Claude may not be installed)",
    };
  }

  const local = parseSemver(localVersion);
  const remote = parseSemver(remoteVersion);

  if (!local || !remote) {
    return { compatible: true };
  }

  if (local.major !== remote.major) {
    return {
      compatible: true,
      warning: `Major version mismatch: local ${localVersion} vs remote ${remoteVersion}`,
    };
  }

  if (local.minor !== remote.minor) {
    log.dim(`Minor version difference: local ${localVersion} vs remote ${remoteVersion}`);
  }

  return { compatible: true };
}
