import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  inventoryFingerprint,
  type InventoryEntry,
} from "./inventory.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";
import { parseSshTarget } from "./ssh-target.ts";
import { runProcess, type ProcessResult } from "../utils/process.ts";
import type { HostCapabilities } from "./codex-plugin-policy.ts";

export const MAX_PUSH_OBSERVATION_ENTRIES = 100_000;
export const MAX_PUSH_OBSERVATION_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_STDOUT_BYTES = 64 * 1024 * 1024;
export const PUSH_OBSERVATION_TIMEOUT_MS = 30_000;

export interface PushObservationQueries {
  readonly pathExistence?: readonly string[];
  readonly commandNames?: readonly string[];
  readonly capturePaths?: readonly string[];
  readonly marketplaceNames?: readonly string[];
  readonly sharedSkillNames?: boolean;
}

export interface PushObservationTransport {
  run(
    host: string,
    argvCommand: readonly string[],
    options: { maxBuffer: number; timeout: number },
  ): Promise<Pick<ProcessResult, "stdout" | "stderr" | "exitCode">>;
}

export interface PrivatePushTargetFacts {
  readonly home: string;
  readonly pathExistence: ReadonlyMap<string, boolean>;
  readonly commandPaths: ReadonlyMap<string, string | null>;
  readonly captures: ReadonlyMap<string, Uint8Array | null>;
  readonly marketplacePayloads: ReadonlyMap<string, boolean>;
  readonly sharedSkillNames: readonly string[];
}

export interface PushTargetObservation {
  readonly capabilities: HostCapabilities;
  readonly inventory: readonly InventoryEntry[];
  readonly facts: PrivatePushTargetFacts;
  readonly pushStateFingerprint: PlanFingerprint;
}

const defaultTransport: PushObservationTransport = {
  async run(host, argvCommand, options) {
    return runProcess("ssh", [host, ...argvCommand], { maxBuffer: options.maxBuffer });
  },
};

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function validateAbsolute(path: string, label: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes(".."))
    throw new Error(`Invalid ${label}: ${JSON.stringify(path)}`);
}

/** One read-only POSIX-sh probe. It intentionally has no temp files; re-observation seals TOCTOU at apply time. */
export function buildRemotePushObservationProbe(
  incoming: readonly InventoryEntry[],
  queries: PushObservationQueries = {},
): string {
  const roots = groupManagedTopLevelEntries(incoming).map((group) => group.path);
  const encoded = (values: readonly string[]) => values.map((v) => q(b64(v))).join(" ");
  return `set -eu
emit(){ printf '%s\\t%b\\n' "$1" "$2"; }
enc(){ if printf '' | base64 2>/dev/null | grep -q '^$'; then base64 | tr -d '\\n'; else base64 | tr -d '\\n'; fi; }
hash(){ (sha256sum 2>/dev/null || shasum -a 256 2>/dev/null) | awk '{print $1}'; }
mode(){ (stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null); }
size(){ (stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null); }
dec(){ printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D; }
home=\${HOME-}; case "$home" in /*) ;; *) exit 41;; esac; case "$home" in *'/../'*|*/..|*/./*|*/.) exit 41;; esac
printf 'CCM_PUSH_OBSERVATION\\t1\\n'; emit HOME "$(printf '%s' "$home"|enc)"
emit OS "$(uname -s|enc)"; emit ARCH "$(uname -m|enc)"
gui=false; [ "$(uname -s)" = Darwin ] && [ -n "\${DISPLAY-}\${WAYLAND_DISPLAY-}\${TERM_PROGRAM-}" ] && gui=true; emit GUI "$gui"
for x in ${encoded([...new Set(queries.commandNames ?? [])].sort())}; do n=$(dec "$x"); p=$(command -v "$n" 2>/dev/null || true); emit CMD "$x\\t$(printf '%s' "$p"|enc)"; done
for x in ${encoded([...new Set(queries.pathExistence ?? [])].sort())}; do p=$(dec "$x"); v=false; [ -e "$p" ] || [ -L "$p" ] && v=true; emit EXISTS "$x\\t$v"; done
for x in ${encoded([...new Set(queries.capturePaths ?? [])].sort())}; do p=$(dec "$x"); if [ -f "$p" ] && [ ! -L "$p" ]; then z=$(size "$p"); [ "$z" -le ${MAX_PUSH_OBSERVATION_FILE_BYTES} ] || exit 42; emit CAPTURE "$x\\t$z\\t$(hash <"$p")\\t$(enc <"$p")"; else emit CAPTURE "$x\\t-"; fi; done
walk(){ ( logical=$1; live=$2; [ -e "$live" ] || [ -L "$live" ] || return 0; if [ -L "$live" ]; then t=$(readlink "$live"); z=$(printf '%s' "$t"|wc -c|tr -d ' '); h=$(printf 'ccm:inventory:symlink-target\\0%s' "$t"|hash); emit ENTRY "$(printf '%s' "$logical"|enc)\\tsymlink\\t755\\t$z\\t$h"; elif [ -f "$live" ]; then z=$(size "$live"); [ "$z" -le ${MAX_PUSH_OBSERVATION_FILE_BYTES} ] || exit 42; m=$(mode "$live"); case "$m" in *[1357]) m=755;; *) m=644;; esac; emit ENTRY "$(printf '%s' "$logical"|enc)\\tfile\\t$m\\t$z\\t$(hash <"$live")"; elif [ -d "$live" ]; then for c in "$live"/* "$live"/.[!.]* "$live"/..?*; do [ -e "$c" ] || [ -L "$c" ] || continue; n=\${c##*/}; walk "$logical/$n" "$c"; done; else exit 43; fi; ); }
for x in ${encoded(roots)}; do l=$(dec "$x"); case "$l" in claude/*) p="$home/.claude/\${l#claude/}";; codex/*) p="$home/.codex/\${l#codex/}";; shared/agents/*) p="$home/.agents/\${l#shared/agents/}";; *) exit 44;; esac; walk "$l" "$p"; done
for x in ${encoded([...new Set(queries.marketplaceNames ?? [])].sort())}; do n=$(dec "$x"); v=false; [ -e "$home/.codex/.ccm/marketplaces/$n" ] || [ -L "$home/.codex/.ccm/marketplaces/$n" ] && v=true; emit MARKET "$x\\t$v"; done
${queries.sharedSkillNames ? `if [ -d "$home/.agents/skills" ] && [ ! -L "$home/.agents/skills" ]; then for p in "$home/.agents/skills"/*; do [ -d "$p" ] && [ ! -L "$p" ] || continue; emit SKILL "$(printf '%s' "\${p##*/}"|enc)"; done; fi` : ":"}
printf 'END\\n'`;
}

function decode(value: string): string {
  if (
    value === "" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Invalid observation base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Non-canonical observation base64");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("NUL in observation value");
  return text;
}

export function parseRemotePushObservation(
  stdout: string,
  incoming: readonly InventoryEntry[],
  queries: PushObservationQueries = {},
): PushTargetObservation {
  if (Buffer.byteLength(stdout) > MAX_PUSH_OBSERVATION_STDOUT_BYTES)
    throw new Error("Push observation stdout cap exceeded");
  const lines = stdout.split("\n");
  if (lines.pop() !== "") throw new Error("Push observation trailing junk");
  if (lines.shift() !== "CCM_PUSH_OBSERVATION\t1" || lines.pop() !== "END")
    throw new Error("Invalid push observation envelope");
  let home: string | undefined,
    os: string | undefined,
    arch: string | undefined,
    gui: boolean | undefined;
  const inventory: InventoryEntry[] = [],
    exists = new Map<string, boolean>(),
    commands = new Map<string, string | null>(),
    captures = new Map<string, Uint8Array | null>(),
    markets = new Map<string, boolean>();
  const skills: string[] = [];
  let total = 0;
  const singleton = new Set<string>();
  for (const line of lines) {
    const [kind = "", ...f] = line.split("\t");
    if (["HOME", "OS", "ARCH", "GUI"].includes(kind)) {
      if (singleton.has(kind)) throw new Error(`Duplicate ${kind}`);
      singleton.add(kind);
    }
    if (kind === "HOME") home = decode(f[0] ?? "");
    else if (kind === "OS") os = decode(f[0] ?? "");
    else if (kind === "ARCH") arch = decode(f[0] ?? "");
    else if (kind === "GUI" && f.length === 1 && /^(true|false)$/.test(f[0] ?? ""))
      gui = f[0] === "true";
    else if (kind === "CMD" && f.length === 2) {
      const k = decode(f[0] ?? ""),
        v = decode(f[1] ?? "");
      if (commands.has(k)) throw new Error("Duplicate CMD");
      commands.set(k, v || null);
    } else if (kind === "EXISTS" && f.length === 2) {
      const k = decode(f[0] ?? "");
      if (exists.has(k) || !/^(true|false)$/.test(f[1] ?? "")) throw new Error("Invalid EXISTS");
      exists.set(k, f[1] === "true");
    } else if (kind === "MARKET" && f.length === 2) {
      const k = decode(f[0] ?? "");
      if (markets.has(k) || !/^(true|false)$/.test(f[1] ?? "")) throw new Error("Invalid MARKET");
      markets.set(k, f[1] === "true");
    } else if (kind === "SKILL" && f.length === 1) skills.push(decode(f[0] ?? ""));
    else if (kind === "CAPTURE" && f.length === 2 && f[1] === "-") {
      const k = decode(f[0] ?? "");
      if (captures.has(k)) throw new Error("Duplicate CAPTURE");
      captures.set(k, null);
    } else if (kind === "CAPTURE" && f.length === 4) {
      const k = decode(f[0] ?? ""),
        n = Number(f[1]),
        encodedData = f[3] ?? "",
        data = Buffer.from(encodedData, "base64");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedData) ||
        data.toString("base64") !== encodedData
      )
        throw new Error("Invalid CAPTURE");
      if (
        captures.has(k) ||
        !Number.isSafeInteger(n) ||
        n < 0 ||
        n > MAX_PUSH_OBSERVATION_FILE_BYTES ||
        data.length !== n ||
        createHash("sha256").update(data).digest("hex") !== f[2]
      )
        throw new Error("Invalid CAPTURE");
      total += n;
      captures.set(k, data);
    } else if (kind === "ENTRY" && f.length === 5) {
      const size = Number(f[3]);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_PUSH_OBSERVATION_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(f[4] ?? "")
      )
        throw new Error("Invalid ENTRY");
      inventory.push({
        path: decode(f[0] ?? ""),
        type: f[1] as "file" | "symlink",
        mode: (f[2] === "644" ? 0o644 : f[2] === "755" ? 0o755 : Number.NaN) as 420 | 493,
        size,
        sha256: f[4] ?? "",
      });
      total += size;
    } else throw new Error(`Unknown or malformed observation record: ${kind}`);
    if (inventory.length > MAX_PUSH_OBSERVATION_ENTRIES || total > MAX_PUSH_OBSERVATION_TOTAL_BYTES)
      throw new Error("Push observation budget exceeded");
  }
  if (!home || !os || !arch || gui === undefined) throw new Error("Incomplete push observation");
  validateAbsolute(home, "remote HOME");
  const requested = new Set(groupManagedTopLevelEntries(incoming).map((g) => g.path));
  const canon = canonicalInventory(inventory);
  for (const e of canon)
    if (![...requested].some((r) => e.path === r || e.path.startsWith(`${r}/`)))
      throw new Error(`Unexpected inventory prefix: ${e.path}`);
  const requireKeys = (
    actual: ReadonlyMap<string, unknown>,
    expected: readonly string[],
    label: string,
  ) => {
    const want = [...new Set(expected)].sort();
    if (actual.size !== want.length || want.some((k) => !actual.has(k)))
      throw new Error(`Missing or unexpected ${label}`);
  };
  requireKeys(commands, queries.commandNames ?? [], "CMD");
  requireKeys(exists, queries.pathExistence ?? [], "EXISTS");
  requireKeys(captures, queries.capturePaths ?? [], "CAPTURE");
  requireKeys(markets, queries.marketplaceNames ?? [], "MARKET");
  const capabilities = {
    os,
    arch,
    gui,
    commands: [...commands]
      .filter(([, v]) => v !== null)
      .map(([k]) => k)
      .sort(),
  };
  const facts = {
    home,
    pathExistence: exists,
    commandPaths: commands,
    captures,
    marketplacePayloads: markets,
    sharedSkillNames: [...new Set(skills)].sort(),
  };
  const factsDigest = createHash("sha256")
    .update(
      JSON.stringify({
        existence: [...exists.values()],
        commands: [...commands.values()].map(Boolean),
        captures: [...captures.values()].map(
          (v) => v && createHash("sha256").update(v).digest("hex"),
        ),
        markets: [...markets.values()],
        skills: facts.sharedSkillNames,
      }),
    )
    .digest("hex");
  return {
    capabilities,
    inventory: canon,
    facts,
    pushStateFingerprint: fingerprint("push-target-v1", {
      inventory: inventoryFingerprint(canon),
      os,
      arch,
      gui,
      factsDigest,
    }),
  };
}

export async function observeRemotePushTarget(input: {
  readonly host: string;
  readonly incoming: readonly InventoryEntry[];
  readonly queries?: PushObservationQueries;
  readonly transport?: PushObservationTransport;
}): Promise<PushTargetObservation> {
  parseSshTarget(input.host);
  canonicalInventory(input.incoming);
  const queries = input.queries ?? {};
  for (const p of [...(queries.pathExistence ?? []), ...(queries.capturePaths ?? [])])
    validateAbsolute(p, "query path");
  for (const n of [...(queries.commandNames ?? []), ...(queries.marketplaceNames ?? [])])
    if (n !== basename(n) || !/^[A-Za-z0-9._@+-]+$/.test(n))
      throw new Error(`Invalid observation name: ${JSON.stringify(n)}`);
  const probe = buildRemotePushObservationProbe(input.incoming, queries);
  const result = await (input.transport ?? defaultTransport).run(input.host, ["sh", "-c", probe], {
    maxBuffer: MAX_PUSH_OBSERVATION_STDOUT_BYTES,
    timeout: PUSH_OBSERVATION_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new Error(`Remote push observation failed (${result.exitCode}): ${result.stderr.trim()}`);
  return parseRemotePushObservation(result.stdout, input.incoming, queries);
}
