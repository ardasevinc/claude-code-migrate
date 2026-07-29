import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type ProcessResult, runProcess } from "../utils/process.ts";
import { shellQuote } from "../utils/shell.ts";
import type { HostCapabilities } from "./codex-plugin-policy.ts";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  type InventoryEntry,
  inventoryFingerprint,
} from "./inventory.ts";
import { fingerprint, type PlanFingerprint } from "./migration-plan.ts";
import { parseSshTarget } from "./ssh-target.ts";

export const MAX_PUSH_OBSERVATION_ENTRIES = 100_000;
export const MAX_PUSH_OBSERVATION_CAPTURE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_CAPTURE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_INVENTORY_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_INVENTORY_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES = 1024 * 1024;
export const PUSH_OBSERVATION_TIMEOUT_MS = 60_000;

export interface PushObservationQueries {
  readonly pathExistence?: readonly string[];
  readonly commandNames?: readonly string[];
  readonly capturePaths?: readonly string[];
  /** Home-relative captures whose live paths are resolved by the probe after observing HOME. */
  readonly captureIds?: readonly PushCaptureId[];
  readonly marketplaceNames?: readonly string[];
  readonly sharedSkillNames?: boolean;
  readonly codexPluginList?: boolean;
}

export type PushCaptureId = "claude-mcp" | "codex-config";

/** Shell helpers shared by every remote capability probe. Assumes canonical `$home`. */
export function buildRemoteExecutableResolverShell(): string {
  return `findcmd(){ p=$(command -v "$1" 2>/dev/null || true); case "$p" in /*) [ -f "$p" ] && [ -x "$p" ] || p=;; *) p=;; esac; if [ -z "$p" ]; then for c in "$home/.bun/bin/$1" "$home/.local/bin/$1" "$home/bin/$1" "/usr/local/bin/$1" "/usr/bin/$1"; do if [ -f "$c" ] && [ -x "$c" ]; then p=$c; break; fi; done; fi; printf '%s' "$p"; }
resolve(){ "$python_path" -c 'import os,sys; p=os.path.realpath(sys.argv[1]); ok=os.path.isabs(p) and os.path.isfile(p) and os.access(p, os.X_OK); print(p) if ok else None; raise SystemExit(0 if ok else 1)' "$1"; }`;
}

export interface PushObservationTransport {
  run(
    host: string,
    argvCommand: string,
    options: { maxBuffer: number; timeout: number },
  ): Promise<Pick<ProcessResult, "stdout" | "stderr" | "exitCode">>;
}

export interface PrivatePushTargetFacts {
  readonly home: string;
  readonly pathExistence: ReadonlyMap<string, boolean>;
  /** Canonical, symlink-resolved absolute executable paths, or null when unavailable. */
  readonly commandPaths: ReadonlyMap<string, string | null>;
  readonly captures: ReadonlyMap<string, Uint8Array | null>;
  readonly marketplacePayloads: ReadonlyMap<string, boolean>;
  readonly sharedSkillNames: readonly string[];
  readonly codexPluginList:
    | {
        readonly status: "missing" | "failed";
        readonly installed: readonly [];
        readonly available: readonly [];
      }
    | {
        readonly status: "ok";
        readonly installed: readonly string[];
        readonly available: readonly string[];
      };
}

export interface PushTargetObservation {
  readonly capabilities: HostCapabilities;
  readonly inventory: readonly InventoryEntry[];
  readonly facts: PrivatePushTargetFacts;
  readonly pushStateFingerprint: PlanFingerprint;
  readonly requestIdentity?: PlanFingerprint;
}

export type PushState = Omit<PushTargetObservation, "pushStateFingerprint">;

/** Canonical fingerprint for both observed and projected push state. */
export function pushStateFingerprint(state: PushState): PlanFingerprint {
  const factsDigest = createHash("sha256")
    .update(
      JSON.stringify({
        home: createHash("sha256").update("ccm:push:home\0").update(state.facts.home).digest("hex"),
        commands: [...state.facts.commandPaths.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, path]) => [
            name,
            path === null
              ? null
              : createHash("sha256").update("ccm:push:command\0").update(path).digest("hex"),
          ]),
        captures: [...state.facts.captures.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => [
            name,
            value && createHash("sha256").update(value).digest("hex"),
          ]),
        existence: [...state.facts.pathExistence.entries()].sort(([a], [b]) => a.localeCompare(b)),
        markets: [...state.facts.marketplacePayloads.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        skills: [...state.facts.sharedSkillNames].sort(),
        codexPluginList: {
          ...state.facts.codexPluginList,
          installed: [...state.facts.codexPluginList.installed].sort(),
          available: [...state.facts.codexPluginList.available].sort(),
        },
      }),
    )
    .digest("hex");
  return fingerprint("push-state-v1", {
    inventory: inventoryFingerprint(state.inventory),
    os: state.capabilities.os,
    arch: state.capabilities.arch,
    gui: state.capabilities.gui,
    factsDigest,
  });
}

const defaultTransport: PushObservationTransport = {
  async run(host, argvCommand, options) {
    return runProcess("ssh", [host, argvCommand], {
      maxBuffer: options.maxBuffer,
      timeoutMs: options.timeout,
    });
  },
};

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function validateAbsolute(path: string, label: string): void {
  if (
    Buffer.byteLength(path) > 4096 ||
    !/^\/(?!\/)(?!$)/.test(path) ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    hasControl(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(`Invalid ${label}: ${JSON.stringify(path)}`);
}

function validateExistencePath(path: string): void {
  if (!path.startsWith("~/")) {
    validateAbsolute(path, "query path");
    return;
  }
  const relative = path.slice(2);
  if (
    Buffer.byteLength(path) > 4096 ||
    relative.length === 0 ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    hasControl(path) ||
    relative.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(`Invalid query path: ${JSON.stringify(path)}`);
}

function buildPythonInventoryProgram(): string {
  return [
    "import base64,hashlib,os,stat,sys",
    `max_entries=${MAX_PUSH_OBSERVATION_ENTRIES}`,
    `max_file=${MAX_PUSH_OBSERVATION_INVENTORY_FILE_BYTES}`,
    `max_total=${MAX_PUSH_OBSERVATION_INVENTORY_TOTAL_BYTES}`,
    "home=os.fsencode(sys.argv[1])",
    "count=0",
    "total=0",
    "def dec(value): return base64.b64decode(value,validate=True)",
    "def enc(value): return base64.b64encode(value)",
    "def emit(logical,kind,mode,size,digest): sys.stdout.buffer.write(b'ENTRY\\t'+enc(logical)+b'\\t'+kind+b'\\t'+mode+b'\\t'+str(size).encode()+b'\\t'+digest+b'\\n')",
    "def walk(logical,live):",
    " global count,total",
    " name=os.path.basename(live)",
    " if name==b'.git' or logical==b'codex/skills/.system' or logical.startswith(b'codex/skills/.system/'): return",
    " try: meta=os.lstat(live)",
    " except FileNotFoundError: return",
    " if stat.S_ISLNK(meta.st_mode):",
    "  target=os.readlink(live)",
    "  digest=hashlib.sha256(b'ccm:inventory:symlink-target\\0'+target).hexdigest().encode()",
    "  size=len(target)",
    "  kind=b'symlink'",
    "  mode=b'755'",
    " elif stat.S_ISREG(meta.st_mode):",
    "  size=meta.st_size",
    "  if size>max_file: raise SystemExit(42)",
    "  digestor=hashlib.sha256()",
    "  with open(live,'rb',buffering=0) as source:",
    "   for chunk in iter(lambda:source.read(1024*1024),b''): digestor.update(chunk)",
    "  digest=digestor.hexdigest().encode()",
    "  kind=b'file'",
    "  mode=b'755' if meta.st_mode&0o111 else b'644'",
    " elif stat.S_ISDIR(meta.st_mode):",
    "  with os.scandir(live) as directory:",
    "   children=sorted(directory,key=lambda child:child.name if isinstance(child.name,bytes) else os.fsencode(child.name))",
    "  for child in children:",
    "   child_name=child.name if isinstance(child.name,bytes) else os.fsencode(child.name)",
    "   walk(logical+b'/'+child_name,live+b'/'+child_name)",
    "  return",
    " else: raise SystemExit(43)",
    " count+=1",
    " total+=size",
    " if count>max_entries or total>max_total: raise SystemExit(42)",
    " emit(logical,kind,mode,size,digest)",
    "for encoded_root in sys.argv[2:]:",
    " logical=dec(encoded_root)",
    " if logical.startswith(b'claude/'): live=home+b'/.claude/'+logical[len(b'claude/'):]",
    " elif logical.startswith(b'codex/'): live=home+b'/.codex/'+logical[len(b'codex/'):]",
    " elif logical.startswith(b'shared/agents/'): live=home+b'/.agents/'+logical[len(b'shared/agents/'):]",
    " else: raise SystemExit(44)",
    " walk(logical,live)",
  ].join("\n");
}

/** One probe with no explicit writes. Reads may update atime; re-observation seals shell TOCTOU at apply time. */
export function buildRemotePushObservationProbe(
  incoming: readonly InventoryEntry[],
  queries: PushObservationQueries = {},
  inventoryRoots?: readonly string[],
): string {
  const roots = (
    inventoryRoots ?? groupManagedTopLevelEntries(incoming).map((group) => group.path)
  ).filter((path) => path !== "claude/.mcp-config.json");
  const commandNames = [
    ...new Set([...(queries.commandNames ?? []), ...(queries.codexPluginList ? ["codex"] : [])]),
  ].sort();
  const encoded = (values: readonly string[]) => values.map((v) => q(b64(v))).join(" ");
  const inventoryProgram = q(buildPythonInventoryProgram());
  return `set -eu
emit(){ printf '%s' "$1"; shift; for field do printf '\\t%s' "$field"; done; printf '\\n'; }
enc(){ if printf '' | base64 2>/dev/null | grep -q '^$'; then base64 | tr -d '\\n'; else base64 | tr -d '\\n'; fi; }
hash(){ (sha256sum 2>/dev/null || shasum -a 256 2>/dev/null) | awk '{print $1}'; }
mode(){ (stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null); }
size(){ (stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null); }
dec(){ printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D; }
home=\${HOME-}; case "$home" in /*) ;; *) exit 41;; esac; case "$home" in *'/../'*|*/..|*/./*|*/.) exit 41;; esac
home=$(cd -P "$home" && pwd -P) || exit 41
printf 'CCM_PUSH_OBSERVATION\\t1\\n'; emit HOME "$(printf '%s' "$home"|enc)"
os=$(uname -s); arch=$(uname -m); emit OS "$(printf '%s' "$os"|enc)"; emit ARCH "$(printf '%s' "$arch"|enc)"
gui=false; [ "$(uname -s)" = Darwin ] && [ -n "\${DISPLAY-}\${WAYLAND_DISPLAY-}\${TERM_PROGRAM-}" ] && gui=true; emit GUI "$gui"
${buildRemoteExecutableResolverShell()}
python_path=$(findcmd python3); [ -n "$python_path" ] || exit 46
python_path=$(resolve "$python_path") || exit 46
python_path=$("$python_path" -I -c 'import os,sys; print(os.path.realpath(sys.executable))') || exit 46
python_path=$(resolve "$python_path") || exit 46
codex_path=; for x in ${encoded(commandNames)}; do n=$(dec "$x"); p=$(findcmd "$n"); if [ -n "$p" ]; then p=$(resolve "$p" 2>/dev/null || true); fi; [ "$n" = codex ] && codex_path=$p; if [ -n "$p" ]; then emit CMD "$x" "$(printf '%s' "$p"|enc)"; else emit CMD "$x" -; fi; done
for x in ${encoded([...new Set(queries.pathExistence ?? [])].sort())}; do p=$(dec "$x"); case "$p" in '~/'*) live="$home/\${p#??}";; *) live=$p;; esac; v=false; [ -e "$live" ] || [ -L "$live" ] && v=true; emit EXISTS "$x" "$v"; done
for x in ${encoded([...new Set(queries.capturePaths ?? [])].sort())}; do p=$(dec "$x"); if [ -f "$p" ] && [ ! -L "$p" ]; then z=$(size "$p"); [ "$z" -le ${MAX_PUSH_OBSERVATION_CAPTURE_FILE_BYTES} ] || exit 42; emit CAPTURE "$x" "$z" "$(hash <"$p")" "$(enc <"$p")"; else emit CAPTURE "$x" -; fi; done
for x in ${encoded([...new Set(queries.captureIds ?? [])].sort())}; do i=$(dec "$x"); case "$i" in claude-mcp) p="$home/.claude.json";; codex-config) p="$home/.codex/config.toml";; *) exit 44;; esac; if [ -f "$p" ] && [ ! -L "$p" ]; then z=$(size "$p"); [ "$z" -le ${MAX_PUSH_OBSERVATION_CAPTURE_FILE_BYTES} ] || exit 42; emit CAPTURE "$x" "$z" "$(hash <"$p")" "$(enc <"$p")"; else emit CAPTURE "$x" -; fi; done
"$python_path" -I -c ${inventoryProgram} "$home" ${encoded(roots)}
for x in ${encoded([...new Set(queries.marketplaceNames ?? [])].sort())}; do n=$(dec "$x"); v=false; [ -e "$home/.codex/.ccm/marketplaces/$n" ] || [ -L "$home/.codex/.ccm/marketplaces/$n" ] && v=true; emit MARKET "$x" "$v"; done
${queries.sharedSkillNames ? `if [ -d "$home/.agents/skills" ] && [ ! -L "$home/.agents/skills" ]; then for p in "$home/.agents/skills"/*; do [ -d "$p" ] && [ ! -L "$p" ] || continue; emit SKILL "$(printf '%s' "\${p##*/}"|enc)"; done; fi` : ":"}
${queries.codexPluginList ? `if [ -z "$codex_path" ]; then emit PLUGINS missing; elif output=$("$codex_path" plugin list --available --json 2>/dev/null); then z=$(printf '%s' "$output"|wc -c|tr -d ' '); [ "$z" -le ${MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES} ] || exit 45; emit PLUGINS ok "$(printf '%s' "$output"|enc)"; else emit PLUGINS failed; fi` : ":"}
printf 'END\\n'`;
}

function parsePluginIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Codex plugin list ${field}`);
  const ids = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`Invalid Codex plugin list ${field}`);
    const id = (item as { pluginId?: unknown }).pluginId;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      Buffer.byteLength(id) > 512 ||
      hasControl(id) ||
      !/^[A-Za-z0-9._+-]+@[A-Za-z0-9._+-]+$/.test(id)
    )
      throw new Error(`Invalid Codex plugin ID`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate Codex plugin ID`);
  return ids.sort();
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
  inventoryRoots?: readonly string[],
  requestIdentity?: PlanFingerprint,
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
  let codexPluginList: PrivatePushTargetFacts["codexPluginList"] | undefined;
  let captureTotal = 0,
    inventoryTotal = 0;
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
        v = f[1] === "-" ? null : decode(f[1] ?? "");
      if (commands.has(k)) throw new Error("Duplicate CMD");
      if (v !== null) validateAbsolute(v, "resolved command path");
      commands.set(k, v);
    } else if (kind === "EXISTS" && f.length === 2) {
      const k = decode(f[0] ?? "");
      if (exists.has(k) || !/^(true|false)$/.test(f[1] ?? "")) throw new Error("Invalid EXISTS");
      exists.set(k, f[1] === "true");
    } else if (kind === "MARKET" && f.length === 2) {
      const k = decode(f[0] ?? "");
      if (markets.has(k) || !/^(true|false)$/.test(f[1] ?? "")) throw new Error("Invalid MARKET");
      markets.set(k, f[1] === "true");
    } else if (kind === "SKILL" && f.length === 1) {
      if (!queries.sharedSkillNames) throw new Error("Unexpected SKILL");
      const name = decode(f[0] ?? "");
      if (
        name !== basename(name) ||
        name === "." ||
        name === ".." ||
        name.includes("\\") ||
        hasControl(name) ||
        skills.includes(name)
      )
        throw new Error("Invalid SKILL");
      skills.push(name);
    } else if (kind === "CAPTURE" && f.length === 2 && f[1] === "-") {
      const k = decode(f[0] ?? "");
      if (captures.has(k)) throw new Error("Duplicate CAPTURE");
      captures.set(k, null);
    } else if (
      kind === "PLUGINS" &&
      queries.codexPluginList &&
      f.length === 1 &&
      /^(missing|failed)$/.test(f[0] ?? "")
    ) {
      if (codexPluginList) throw new Error("Duplicate PLUGINS");
      codexPluginList = { status: f[0] as "missing" | "failed", installed: [], available: [] };
    } else if (kind === "PLUGINS" && queries.codexPluginList && f.length === 2 && f[0] === "ok") {
      if (codexPluginList) throw new Error("Duplicate PLUGINS");
      const raw = decode(f[1] ?? "");
      if (Buffer.byteLength(raw) > MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES)
        throw new Error("Codex plugin list cap exceeded");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Invalid Codex plugin list JSON");
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => key !== "installed" && key !== "available")
      )
        throw new Error("Invalid Codex plugin list schema");
      const record = parsed as { installed?: unknown; available?: unknown };
      const installed = parsePluginIds(record.installed, "installed");
      const installedSet = new Set(installed);
      const available = parsePluginIds(record.available, "available").filter(
        (id) => !installedSet.has(id),
      );
      codexPluginList = {
        status: "ok",
        installed,
        available,
      };
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
        n > MAX_PUSH_OBSERVATION_CAPTURE_FILE_BYTES ||
        data.length !== n ||
        createHash("sha256").update(data).digest("hex") !== f[2]
      )
        throw new Error("Invalid CAPTURE");
      captureTotal += n;
      captures.set(k, data);
    } else if (kind === "ENTRY" && f.length === 5) {
      const size = Number(f[3]);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_PUSH_OBSERVATION_INVENTORY_FILE_BYTES ||
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
      inventoryTotal += size;
    } else throw new Error(`Unknown or malformed observation record: ${kind}`);
    if (
      inventory.length > MAX_PUSH_OBSERVATION_ENTRIES ||
      captureTotal > MAX_PUSH_OBSERVATION_CAPTURE_TOTAL_BYTES ||
      inventoryTotal > MAX_PUSH_OBSERVATION_INVENTORY_TOTAL_BYTES
    )
      throw new Error("Push observation budget exceeded");
  }
  if (!home || !os || !arch || gui === undefined) throw new Error("Incomplete push observation");
  if (queries.codexPluginList && !codexPluginList) throw new Error("Missing PLUGINS");
  validateAbsolute(home, "remote HOME");
  const requested = new Set(
    (inventoryRoots ?? groupManagedTopLevelEntries(incoming).map((group) => group.path)).filter(
      (path) => path !== "claude/.mcp-config.json",
    ),
  );
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
  requireKeys(
    commands,
    [...(queries.commandNames ?? []), ...(queries.codexPluginList ? ["codex"] : [])],
    "CMD",
  );
  requireKeys(exists, queries.pathExistence ?? [], "EXISTS");
  requireKeys(
    captures,
    [...(queries.capturePaths ?? []), ...(queries.captureIds ?? [])],
    "CAPTURE",
  );
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
    codexPluginList: codexPluginList ?? { status: "missing", installed: [], available: [] },
  };
  const state = { capabilities, inventory: canon, facts };
  return {
    ...state,
    pushStateFingerprint: pushStateFingerprint(state),
    requestIdentity,
  };
}

export async function observeRemotePushTarget(input: {
  readonly host: string;
  readonly incoming: readonly InventoryEntry[];
  readonly queries?: PushObservationQueries;
  readonly inventoryRoots?: readonly string[];
  readonly requestIdentity?: PlanFingerprint;
  readonly transport?: PushObservationTransport;
}): Promise<PushTargetObservation> {
  parseSshTarget(input.host);
  canonicalInventory(input.incoming);
  const queries = input.queries ?? {};
  for (const p of queries.pathExistence ?? []) validateExistencePath(p);
  for (const p of queries.capturePaths ?? []) validateAbsolute(p, "query path");
  for (const id of queries.captureIds ?? [])
    if (id !== "claude-mcp" && id !== "codex-config")
      throw new Error(`Invalid push capture ID: ${JSON.stringify(id)}`);
  for (const n of [...(queries.commandNames ?? []), ...(queries.marketplaceNames ?? [])])
    if (n !== basename(n) || !/^[A-Za-z0-9._@+-]+$/.test(n))
      throw new Error(`Invalid observation name: ${JSON.stringify(n)}`);
  const probe = buildRemotePushObservationProbe(input.incoming, queries, input.inventoryRoots);
  const result = await (input.transport ?? defaultTransport).run(
    input.host,
    `sh -c ${shellQuote(probe)}`,
    {
      maxBuffer: MAX_PUSH_OBSERVATION_STDOUT_BYTES,
      timeout: PUSH_OBSERVATION_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    const stderr = [...result.stderr]
      .map((character) => (hasControl(character) ? " " : character))
      .join("")
      .trim()
      .slice(0, 512);
    throw new Error(
      `Remote push observation failed (${result.exitCode})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return parseRemotePushObservation(
    result.stdout,
    input.incoming,
    queries,
    input.inventoryRoots,
    input.requestIdentity,
  );
}
