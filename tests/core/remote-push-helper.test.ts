import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../src/core/remote-push-helper.py", import.meta.url));
const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], {
  encoding: "utf8",
}).trim();
const roots: string[] = [];

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(ordered(value));
}

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function archive(path: string, entries: Record<string, string>): Promise<string> {
  const tar = pack();
  const writing = pipeline(tar, createGzip(), createWriteStream(path));
  for (const [name, body] of Object.entries(entries)) tar.entry({ name, mode: 0o644 }, body);
  tar.finalize();
  await writing;
  return sha(await readFile(path));
}

async function replaceWithPaxArchive(
  f: Awaited<ReturnType<typeof fixture>>,
  paxBytes: number,
): Promise<void> {
  const archivePath = join(f.workspace, "archive.tar.gz");
  const tar = pack();
  const writing = pipeline(tar, createGzip(), createWriteStream(archivePath));
  const paxHeader = {
    name: "codex/config.toml",
    mode: 0o644,
    pax: { comment: "x".repeat(paxBytes) },
  } as unknown as Parameters<typeof tar.entry>[0];
  tar.entry(paxHeader, "four");
  tar.finalize();
  await writing;
  const manifestPath = join(f.workspace, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.archiveSha256 = sha(await readFile(archivePath));
  const bytes = canonical(manifest);
  await writeFile(manifestPath, bytes);
  f.prepare.manifestSha256 = sha(bytes);
}

type Action = Record<string, unknown> & { id: string; kind: string };

async function fixture(actions: Action[], entries: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-remote-helper-test-")));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const archivePath = join(workspace, "archive.tar.gz");
  const archiveSha256 = await archive(archivePath, entries);
  const manifest = {
    actions,
    archiveSha256,
    home,
    token: "a".repeat(64),
  };
  const manifestBytes = canonical(manifest);
  await writeFile(join(workspace, "manifest.json"), manifestBytes, { mode: 0o600 });
  return {
    root,
    home,
    workspace,
    token: manifest.token,
    prepare: {
      helperSha256: sha(await readFile(helper)),
      home,
      manifestSha256: sha(manifestBytes),
      op: "prepare",
      pythonPath: python,
      workspace,
    },
  };
}

function runtimeRequest(request: Record<string, unknown>) {
  return { helperSha256: sha(execFileSync("/bin/cat", [helper])), pythonPath: python, ...request };
}

function launchArgsFor(helperPath: string, payload: string, expected: string) {
  const program = [
    "import hashlib,os,stat,sys",
    `p=${JSON.stringify(helperPath)}`,
    `expected=${JSON.stringify(expected)}`,
    "before=os.lstat(p)",
    "fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))",
    "after=os.fstat(fd)",
    "data=b''.join(iter(lambda:os.read(fd,1048576),b''))",
    "os.close(fd)",
    "assert stat.S_ISREG(after.st_mode) and (before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)",
    "assert hashlib.sha256(data).hexdigest()==expected",
    `sys.argv=[p,${JSON.stringify(payload)}]`,
    "exec(compile(data,p,'exec'),{'__name__':'__main__','__file__':p})",
  ].join(";");
  return ["-B", "-c", program];
}

function launchArgs(payload: string) {
  return launchArgsFor(helper, payload, sha(execFileSync("/bin/cat", [helper])));
}

function invokeWithLimits(request: Record<string, unknown>, limits: Record<string, number>) {
  const sealed = runtimeRequest(request);
  const payload = Buffer.from(canonical(sealed)).toString("base64");
  const expected = sealed.helperSha256;
  const assignments = Object.entries(limits)
    .map(([name, value]) => `scope[${JSON.stringify(name)}]=${value}`)
    .join("\n");
  const program = `
import hashlib,os,stat,sys
p=${JSON.stringify(helper)}
before=os.lstat(p)
fd=os.open(p,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
after=os.fstat(fd)
data=b"".join(iter(lambda:os.read(fd,1048576),b""))
os.close(fd)
assert (before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)
assert hashlib.sha256(data).hexdigest()==${JSON.stringify(expected)}
scope={"__name__":"ccm_remote_helper","__file__":p}
exec(compile(data,p,"exec"),scope)
${assignments}
sys.argv=[p,${JSON.stringify(payload)}]
try:
    scope["main"]()
except scope["Blocked"] as error:
    sys.stdout.buffer.write(scope["canonical"]({"error":"blocked","message":str(error)})+b"\\n")
    sys.exit(64)
except Exception as error:
    sys.stdout.buffer.write(scope["canonical"]({"error":"execution","message":str(error)})+b"\\n")
    sys.exit(70)
`;
  const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf8" });
  return {
    code: result.status,
    body: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

function invoke(request: Record<string, unknown>) {
  const payload = Buffer.from(canonical(runtimeRequest(request))).toString("base64");
  const result = spawnSync(python, launchArgs(payload), { encoding: "utf8" });
  return {
    code: result.status,
    body: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

function invokeWithFixedClock(request: Record<string, unknown>, nanoseconds: number) {
  const sealed = runtimeRequest(request);
  const payload = Buffer.from(canonical(sealed)).toString("base64");
  const program = `
import hashlib,os,sys
p=${JSON.stringify(helper)}
before=os.lstat(p); fd=os.open(p,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)); after=os.fstat(fd)
data=b"".join(iter(lambda:os.read(fd,1048576),b"")); os.close(fd)
assert (before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)
assert hashlib.sha256(data).hexdigest()==${JSON.stringify(sealed.helperSha256)}
scope={"__name__":"ccm_remote_helper","__file__":p}; exec(compile(data,p,"exec"),scope)
scope["time"].time_ns=lambda:${nanoseconds}
sys.argv=[p,${JSON.stringify(payload)}]
scope["main"]()
`;
  const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf8" });
  return {
    code: result.status,
    body: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

function session(f: Awaited<ReturnType<typeof fixture>>, op: string, extra = {}) {
  return { home: f.home, op, token: f.token, workspace: f.workspace, ...extra };
}

async function waitFor(path: string) {
  for (let index = 0; index < 250; index++) {
    if (await lstat(path).catch(() => null)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("remote push helper", () => {
  it("requires canonical payloads and matching sealed checksums", async () => {
    const f = await fixture([], {});
    const noncanonical = Buffer.from(
      JSON.stringify(runtimeRequest({ workspace: f.workspace, op: "status", token: f.token })),
    ).toString("base64");
    const rejected = spawnSync(python, launchArgs(noncanonical), { encoding: "utf8" });
    expect(rejected.status).toBe(64);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ message: "request is not canonical JSON" });
    expect(invoke({ ...f.prepare, manifestSha256: "0".repeat(64) })).toMatchObject({
      code: 64,
      body: { message: "manifest checksum mismatch" },
    });

    let raw = canonical(runtimeRequest({ ...f.prepare, padding: "" }));
    while (raw.length % 3 === 0)
      raw = canonical(runtimeRequest({ ...f.prepare, padding: `${JSON.parse(raw).padding}x` }));
    const canonicalPayload = Buffer.from(raw).toString("base64");
    const padding = canonicalPayload.endsWith("==") ? 2 : 1;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const index = canonicalPayload.length - padding - 1;
    const original = alphabet.indexOf(canonicalPayload[index] as string);
    const alternate = `${canonicalPayload.slice(0, index)}${alphabet[(original ^ 1) & 63]}${canonicalPayload.slice(index + 1)}`;
    expect(Buffer.from(alternate, "base64")).toEqual(Buffer.from(canonicalPayload, "base64"));
    const result = spawnSync(python, launchArgs(alternate), { encoding: "utf8" });
    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      message: "request encoding is not canonical base64",
    });
  });

  it("parses as Python 3.8 syntax", () => {
    const result = spawnSync(
      python,
      [
        "-B",
        "-c",
        "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read(),feature_version=(3,8))",
        helper,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("caps pinned commands above the current 260 MiB Codex binary and requires resolved paths", async () => {
    const cap = Number(
      execFileSync(
        python,
        [
          "-B",
          "-c",
          "scope={'__name__':'probe','__file__':__import__('sys').argv[1]};exec(compile(open(__import__('sys').argv[1]).read(),__import__('sys').argv[1],'exec'),scope);print(scope['MAX_PLUGIN_COMMAND_BYTES'])",
          helper,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    expect(cap).toBeGreaterThanOrEqual(260_405_808);

    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-symlink-command-")));
    roots.push(root);
    const command = join(root, "codex-real");
    const link = join(root, "codex-link");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink(command, link);
    const f = await fixture([
      { codexCommand: link, id: "linked", kind: "plugin-add", pluginId: "linked" },
    ]);
    expect(invoke(f.prepare)).toMatchObject({ code: 64 });

    const bounded = await fixture([
      { codexCommand: command, id: "bounded", kind: "plugin-add", pluginId: "bounded" },
    ]);
    expect(invokeWithLimits(bounded.prepare, { MAX_PLUGIN_COMMAND_BYTES: 3 })).toMatchObject({
      code: 64,
      body: { message: "Codex command exceeds pinning limit" },
    });
  });

  it("refuses helper bytes changed after prepare before executing another operation", async () => {
    const f = await fixture([], {});
    const copiedHelper = join(f.root, "remote-helper.py");
    const original = await readFile(helper);
    await writeFile(copiedHelper, original, { mode: 0o700 });
    const expected = sha(original);
    const prepare = { ...f.prepare, helperSha256: expected };
    const preparePayload = Buffer.from(canonical(prepare)).toString("base64");
    expect(spawnSync(python, launchArgsFor(copiedHelper, preparePayload, expected)).status).toBe(0);
    await writeFile(copiedHelper, Buffer.concat([original, Buffer.from("\n# changed\n")]));
    const statusPayload = Buffer.from(
      canonical({
        helperSha256: expected,
        home: f.home,
        op: "status",
        pythonPath: python,
        token: f.token,
        workspace: f.workspace,
      }),
    ).toString("base64");
    const rejected = spawnSync(python, launchArgsFor(copiedHelper, statusPayload, expected), {
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toBe("");
  });

  it("authenticates state and rejects sealed extract mutation or ancestor swaps", async () => {
    const action = { id: "sealed", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const stateFixture = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(stateFixture.home, ".codex"));
    await writeFile(join(stateFixture.home, ".codex", "config.toml"), "old\n");
    expect(invoke(stateFixture.prepare).code).toBe(0);
    const statePath = join(stateFixture.workspace, "state.json");
    const envelope = JSON.parse(await readFile(statePath, "utf8"));
    envelope.payload.next = 1;
    envelope.sha256 = createHmac("sha256", stateFixture.token)
      .update(canonical(envelope.payload))
      .digest("hex");
    await writeFile(statePath, canonical(envelope));
    expect(invoke(session(stateFixture, "status"))).toMatchObject({
      code: 64,
      body: { message: "invalid transaction state" },
    });

    const extractFixture = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(extractFixture.home, ".codex"));
    await writeFile(join(extractFixture.home, ".codex", "config.toml"), "old\n");
    expect(invoke(extractFixture.prepare).code).toBe(0);
    await writeFile(join(extractFixture.workspace, "extract", "codex", "config.toml"), "bad\n");
    expect(invoke(session(extractFixture, "apply", { actionId: action.id }))).toMatchObject({
      code: 64,
      body: { message: "sealed extracted file changed" },
    });
    expect(await readFile(join(extractFixture.home, ".codex", "config.toml"), "utf8")).toBe(
      "old\n",
    );

    const missingFixture = await fixture(
      [{ id: "rules", kind: "overlay-group", logicalGroup: "codex/rules" }],
      { "codex/rules/one.md": "one\n", "codex/rules/two.md": "two\n" },
    );
    expect(invoke(missingFixture.prepare).code).toBe(0);
    await rm(join(missingFixture.workspace, "extract", "codex", "rules", "two.md"));
    expect(invoke(session(missingFixture, "apply", { actionId: "rules" }))).toMatchObject({
      code: 64,
      body: { message: "sealed extracted directory changed" },
    });

    const swapFixture = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(swapFixture.home, ".codex"));
    expect(invoke(swapFixture.prepare).code).toBe(0);
    const outside = join(swapFixture.root, "outside-extract");
    await mkdir(join(outside, "codex"), { recursive: true });
    await writeFile(join(outside, "codex", "config.toml"), "outside\n");
    await rename(
      join(swapFixture.workspace, "extract"),
      join(swapFixture.workspace, "extract-sealed"),
    );
    await symlink(outside, join(swapFixture.workspace, "extract"));
    expect(invoke(session(swapFixture, "apply", { actionId: action.id })).code).not.toBe(0);
    expect(await readFile(join(outside, "codex", "config.toml"), "utf8")).toBe("outside\n");
  });

  it("rejects symlinked workspace or HOME ancestry and runtime drift", async () => {
    const workspaceFixture = await fixture([], {});
    const workspaceAlias = join(workspaceFixture.root, "workspace-alias");
    await symlink(workspaceFixture.workspace, workspaceAlias);
    expect(invoke({ ...workspaceFixture.prepare, workspace: workspaceAlias }).code).not.toBe(0);

    const homeFixture = await fixture([], {});
    const homeAlias = join(homeFixture.root, "home-alias");
    await symlink(homeFixture.home, homeAlias);
    const manifestPath = join(homeFixture.workspace, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.home = homeAlias;
    const bytes = canonical(manifest);
    await writeFile(manifestPath, bytes);
    homeFixture.prepare.manifestSha256 = sha(bytes);
    homeFixture.prepare.home = homeAlias;
    expect(invoke(homeFixture.prepare).code).not.toBe(0);

    const runtime = await fixture([], {});
    expect(invoke(runtime.prepare).code).toBe(0);
    expect(invoke({ ...session(runtime, "status"), helperSha256: "0".repeat(64) })).toMatchObject({
      code: 64,
      body: { message: "helper checksum mismatch" },
    });
    expect(invoke({ ...session(runtime, "status"), pythonPath: "/wrong/python" })).toMatchObject({
      code: 64,
      body: { message: "unexpected Python interpreter" },
    });
  });

  it("retains typed HOME siblings, restores exactly on abort, and rejects replay/order errors", async () => {
    const action = { id: "write-config", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const f = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(f.home, ".codex"));
    const target = join(f.home, ".codex", "config.toml");
    await writeFile(target, "old\n", { mode: 0o640 });

    expect(invoke(f.prepare)).toMatchObject({ code: 0, body: { status: "prepared" } });
    const sibling = (await readdir(dirname(target))).find((name) =>
      /^config\.toml\.backup-\d+$/.test(name),
    );
    expect(sibling).toBeTruthy();
    expect(await readFile(join(dirname(target), sibling as string), "utf8")).toBe("old\n");
    expect(invoke(session(f, "cleanup"))).toMatchObject({ code: 64 });
    expect(invoke(session(f, "apply", { actionId: "wrong" }))).toMatchObject({
      code: 64,
      body: { message: "action is out of order" },
    });
    expect(invoke(session(f, "apply", { actionId: action.id }))).toMatchObject({
      code: 0,
      body: { applied: 1 },
    });
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(invoke(session(f, "apply", { actionId: action.id }))).toMatchObject({ code: 64 });
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0, body: { status: "aborted" } });
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
    expect(await lstat(join(dirname(target), sibling as string)).catch(() => null)).toBeNull();
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0, body: { status: "aborted" } });
    expect(invoke(session(f, "cleanup"))).toMatchObject({ code: 0, body: { status: "cleaned" } });
  });

  it("never follows hostile parent or leaf symlinks outside HOME", async () => {
    const parent = await fixture(
      [{ id: "parent", kind: "overlay-group", logicalGroup: "codex/config.toml" }],
      { "codex/config.toml": "attack\n" },
    );
    const outside = join(parent.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "config.toml"), "sentinel\n");
    await symlink(outside, join(parent.home, ".codex"));
    expect(invoke(parent.prepare).code).not.toBe(0);
    expect(await readFile(join(outside, "config.toml"), "utf8")).toBe("sentinel\n");

    const leaf = await fixture(
      [
        {
          archiveMember: "claude/.mcp-config.json",
          id: "leaf",
          kind: "write-claude-mcp",
        },
      ],
      { "claude/.mcp-config.json": '{"mcpServers":{}}\n' },
    );
    const sentinel = join(leaf.root, "sentinel.json");
    await writeFile(sentinel, "outside\n");
    await symlink(sentinel, join(leaf.home, ".claude.json"));
    expect(invoke(leaf.prepare).code).toBe(0);
    expect(invoke(session(leaf, "apply", { actionId: "leaf" })).code).not.toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
    expect(invoke(session(leaf, "abort")).code).toBe(0);
    expect(await readlink(join(leaf.home, ".claude.json"))).toBe(sentinel);
  });

  it("walks shared skill sources from the pinned HOME descriptor", async () => {
    const f = await fixture([
      {
        id: "views",
        kind: "symlink-view",
        logicalGroup: "claude/skills",
        names: ["hostile"],
      },
    ]);
    const outside = join(f.root, "outside-skill");
    await mkdir(outside);
    await mkdir(join(f.home, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(f.home, ".agents", "skills", "hostile"));
    expect(invoke(f.prepare).code).toBe(0);
    expect(invoke(session(f, "apply", { actionId: "views" }))).toMatchObject({ code: 64 });
    expect(await readdir(outside)).toEqual([]);
  });

  it("round-trips typed directory snapshots without dereferencing their symlinks", async () => {
    const action = { id: "rules", kind: "overlay-group", logicalGroup: "codex/rules" };
    const f = await fixture([action], { "codex/rules/new.md": "new\n" });
    const rules = join(f.home, ".codex", "rules");
    await mkdir(rules, { recursive: true, mode: 0o750 });
    await writeFile(join(rules, "old.md"), "old\n", { mode: 0o600 });
    const sentinel = join(f.root, "sentinel");
    await writeFile(sentinel, "outside\n");
    await symlink(sentinel, join(rules, "view"));

    expect(invoke(f.prepare).code).toBe(0);
    const retained = (await readdir(join(f.home, ".codex"))).find((name) =>
      /^rules\.backup-\d+$/.test(name),
    );
    expect(retained).toBeTruthy();
    expect((await lstat(join(f.home, ".codex", retained as string))).isDirectory()).toBe(true);
    expect(invoke(session(f, "apply", { actionId: action.id })).code).toBe(0);
    expect(await readFile(join(rules, "new.md"), "utf8")).toBe("new\n");
    expect(invoke(session(f, "abort")).code).toBe(0);
    expect((await readdir(rules)).sort()).toEqual(["old.md", "view"]);
    expect(await readFile(join(rules, "old.md"), "utf8")).toBe("old\n");
    expect((await lstat(join(rules, "old.md"))).mode & 0o777).toBe(0o600);
    expect((await lstat(rules)).mode & 0o777).toBe(0o750);
    expect(await readlink(join(rules, "view"))).toBe(sentinel);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
  });

  it("keeps the newest five compatible exact backup names and ignores foreign collisions", async () => {
    const action = { id: "write-config", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const f = await fixture([action], { "codex/config.toml": "new\n" });
    const parent = join(f.home, ".codex");
    await mkdir(parent);
    await writeFile(join(parent, "config.toml"), "old\n");
    for (let index = 1; index <= 6; index++)
      await writeFile(join(parent, `config.toml.backup-${index}`), `${index}\n`);
    await mkdir(join(parent, "config.toml.backup-0"));
    await writeFile(join(parent, "config.toml.backup-foreign"), "foreign\n");
    await writeFile(join(parent, "config.toml.backup-42"), "collision\n");

    expect(invokeWithFixedClock(f.prepare, 42).code).toBe(0);
    expect(await readFile(join(parent, "config.toml.backup-42"), "utf8")).toBe("collision\n");
    expect(await readFile(join(parent, "config.toml.backup-43"), "utf8")).toBe("old\n");
    expect(invoke(session(f, "apply", { actionId: action.id })).code).toBe(0);
    expect(invoke(session(f, "commit"))).toMatchObject({ code: 0, body: { status: "committed" } });
    const names = await readdir(parent);
    expect(
      names.filter(
        (name) => /^config\.toml\.backup-\d+$/.test(name) && name !== "config.toml.backup-0",
      ),
    ).toHaveLength(5);
    expect(names).toContain("config.toml.backup-0");
    expect(names).toContain("config.toml.backup-foreign");
    expect(await readFile(join(parent, "config.toml.backup-foreign"), "utf8")).toBe("foreign\n");
  });

  it("asserts the global HOME lock and ignores late terminal cancellation markers", async () => {
    const action = { id: "lock", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const locked = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(locked.home, ".codex"));
    expect(invoke(locked.prepare).code).toBe(0);
    expect((await lstat(join(locked.home, ".ccm-push.lock"))).isFile()).toBe(true);
    expect(await readFile(join(locked.home, ".ccm-push.lock"), "utf8")).toBe(locked.token);
    await writeFile(join(locked.home, ".ccm-push.lock"), "b".repeat(64));
    expect(invoke(session(locked, "status"))).toMatchObject({
      code: 64,
      body: { message: "transaction does not own lock" },
    });

    const terminal = await fixture([action], { "codex/config.toml": "new\n" });
    await mkdir(join(terminal.home, ".codex"));
    expect(invoke(terminal.prepare).code).toBe(0);
    expect(invoke(session(terminal, "apply", { actionId: action.id })).code).toBe(0);
    expect(invoke(session(terminal, "commit")).code).toBe(0);
    const transactionState = join(terminal.home, `.ccm-push-state-${terminal.token}`);
    expect((await lstat(transactionState)).isDirectory()).toBe(true);
    expect((await lstat(transactionState)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(transactionState, "secret"))).mode & 0o777).toBe(0o600);
    expect(invoke(session(terminal, "cancel"))).toMatchObject({
      code: 0,
      body: { status: "committed" },
    });
    expect(await lstat(join(terminal.workspace, "cancel")).catch(() => null)).toBeNull();
    await writeFile(join(terminal.home, ".ccm-push.lock"), "c".repeat(64), { mode: 0o600 });
    expect(invoke(session(terminal, "cleanup"))).toMatchObject({
      code: 64,
      body: { message: "transaction does not own lock" },
    });
    expect(await readFile(join(terminal.home, ".ccm-push.lock"), "utf8")).toBe("c".repeat(64));
    await rm(join(terminal.home, ".ccm-push.lock"));
    expect(invoke(session(terminal, "cleanup"))).toMatchObject({ code: 0 });
    expect(await lstat(transactionState).catch(() => null)).toBeNull();
  });

  it("retries cleanup after partial workspace deletion and HOME tombstone retirement", async () => {
    for (const partialRetirement of [false, true]) {
      const f = await fixture([], {});
      expect(invoke(f.prepare).code).toBe(0);
      expect(invoke(session(f, "commit"))).toMatchObject({ code: 0 });
      const stateEnvelope = JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8"));
      const active = join(f.home, `.ccm-push-state-${f.token}`);
      const secret = await readFile(join(active, "secret"));
      const payload = {
        token: f.token,
        workspace: f.workspace,
        workspaceIdentity: stateEnvelope.payload.workspaceIdentity,
      };
      await writeFile(
        join(active, "cleanup.json"),
        canonical({
          payload,
          sha256: createHmac("sha256", secret).update(canonical(payload)).digest("hex"),
        }),
      );
      await rm(f.workspace, { recursive: true });
      const retired = join(f.home, `.ccm-push-state-retired-${f.token}`);
      if (partialRetirement) {
        await rename(active, retired);
        await rm(join(retired, "secret"));
      }
      expect(invoke(session(f, "cleanup"))).toMatchObject({ code: 0, body: { status: "cleaned" } });
      expect(await lstat(active).catch(() => null)).toBeNull();
      expect(await lstat(retired).catch(() => null)).toBeNull();
    }

    const partial = await fixture([], {});
    expect(invoke(partial.prepare).code).toBe(0);
    expect(invoke(session(partial, "commit"))).toMatchObject({ code: 0 });
    const partialState = JSON.parse(await readFile(join(partial.workspace, "state.json"), "utf8"));
    const partialActive = join(partial.home, `.ccm-push-state-${partial.token}`);
    const partialSecret = await readFile(join(partialActive, "secret"));
    const partialPayload = {
      token: partial.token,
      workspace: partial.workspace,
      workspaceIdentity: partialState.payload.workspaceIdentity,
    };
    await writeFile(
      join(partialActive, "cleanup.json"),
      canonical({
        payload: partialPayload,
        sha256: createHmac("sha256", partialSecret).update(canonical(partialPayload)).digest("hex"),
      }),
    );
    await rm(join(partial.workspace, "state.json"));
    await rm(join(partial.workspace, "extract"), { recursive: true });
    expect(invoke(session(partial, "cleanup"))).toMatchObject({
      code: 0,
      body: { status: "cleaned" },
    });
    expect(await lstat(partial.workspace).catch(() => null)).toBeNull();

    const replaced = await fixture([], {});
    expect(invoke(replaced.prepare).code).toBe(0);
    expect(invoke(session(replaced, "commit"))).toMatchObject({ code: 0 });
    const replacedState = JSON.parse(
      await readFile(join(replaced.workspace, "state.json"), "utf8"),
    );
    const replacedActive = join(replaced.home, `.ccm-push-state-${replaced.token}`);
    const replacedSecret = await readFile(join(replacedActive, "secret"));
    const replacedPayload = {
      token: replaced.token,
      workspace: replaced.workspace,
      workspaceIdentity: replacedState.payload.workspaceIdentity,
    };
    await writeFile(
      join(replacedActive, "cleanup.json"),
      canonical({
        payload: replacedPayload,
        sha256: createHmac("sha256", replacedSecret)
          .update(canonical(replacedPayload))
          .digest("hex"),
      }),
    );
    await rename(replaced.workspace, `${replaced.workspace}-old`);
    await mkdir(replaced.workspace, { mode: 0o700 });
    expect(invoke(session(replaced, "cleanup"))).toMatchObject({
      code: 64,
      body: { message: "cleanup workspace identity changed" },
    });
    expect((await lstat(replaced.workspace)).isDirectory()).toBe(true);
  });

  it("enforces member, decompressed total, count, and manifest action caps", async () => {
    const action = { id: "limit", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const member = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(member.prepare, { MAX_MEMBER_BYTES: 3 })).toMatchObject({
      code: 64,
      body: { message: "archive member exceeds limit" },
    });
    const total = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(total.prepare, { MAX_DECOMPRESSED_BYTES: 3 })).toMatchObject({
      code: 64,
      body: { message: "decompressed archive exceeds limit" },
    });
    const count = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(count.prepare, { MAX_ARCHIVE_MEMBERS: 0 })).toMatchObject({
      code: 64,
      body: { message: "archive member count exceeds limit" },
    });
    const rawStream = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(rawStream.prepare, { MAX_TAR_STREAM_BYTES: 511 })).toMatchObject({
      code: 64,
      body: { message: "raw decompressed tar stream exceeds limit" },
    });
    const pax = await fixture([action]);
    await replaceWithPaxArchive(pax, 4096);
    expect(invokeWithLimits(pax.prepare, { MAX_TAR_METADATA_BYTES: 2048 })).toMatchObject({
      code: 64,
      body: { message: "tar metadata exceeds limit" },
    });
    const manifest = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(manifest.prepare, { MAX_ACTIONS: 0 })).toMatchObject({
      code: 64,
      body: { message: "invalid transaction manifest" },
    });
    const depth = await fixture([action], { [`codex/${Array(64).fill("x").join("/")}`]: "x" });
    expect(invoke(depth.prepare)).toMatchObject({
      code: 64,
      body: { message: "unsafe archive member" },
    });
    const bytes = await fixture([action], { "codex/config.toml": "four" });
    expect(invokeWithLimits(bytes.prepare, { MAX_MANIFEST_BYTES: 1 })).toMatchObject({
      code: 64,
      body: { message: "file exceeds limit" },
    });
  });

  it("serializes operations, exposes inflight state, cancels plugin work, and compensates it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-helper-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const log = join(root, "plugin.log");
    const installed = join(root, "installed");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,sys,time
op=sys.argv[2]
if op=="list":
    print(json.dumps({"installed":[{"pluginId":"demo@test","installed":True}] if os.path.exists(${JSON.stringify(installed)}) else [],"available":[]})); sys.exit()
with open(${JSON.stringify(log)},"a") as f: f.write(op+"\\n")
if op=="add": open(${JSON.stringify(installed)},"w").close(); time.sleep(10)
if op=="remove":
    try: os.unlink(${JSON.stringify(installed)})
    except FileNotFoundError: pass
`,
    );
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "plugin", kind: "plugin-add", pluginId: "demo@test" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    const payload = Buffer.from(
      canonical(runtimeRequest(session(f, "apply", { actionId: "plugin" }))),
    ).toString("base64");
    const child = spawn(python, launchArgs(payload), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(log);
    const state = JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8")).payload;
    expect(state).toMatchObject({ inflight: "plugin", next: 0 });
    const cancelled = invoke(session(f, "cancel"));
    expect(cancelled).toMatchObject({ code: 0, body: { status: "cancelled" } });
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exit).not.toBe(0);
    expect(await readFile(log, "utf8")).toBe("add\nremove\n");
    expect(await lstat(join(f.home, ".ccm-push.lock")).catch(() => null)).toBeNull();
  });

  it("executes the protected pinned plugin bytes after an in-place command overwrite", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-pinned-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const installed = join(root, "installed");
    const hostile = join(root, "hostile");
    const safeCommand = `#!/usr/bin/env python3
import json,os,sys
if sys.argv[2]=="list": print(json.dumps({"installed":[{"pluginId":"pinned","installed":True}] if os.path.exists(${JSON.stringify(installed)}) else [],"available":[]}))
elif sys.argv[2]=="add": open(${JSON.stringify(installed)},"w").close()
elif sys.argv[2]=="remove": os.unlink(${JSON.stringify(installed)})
`;
    await writeFile(commandPath, safeCommand);
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "pinned-add", kind: "plugin-add", pluginId: "pinned" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3\nopen(${JSON.stringify(hostile)},"w").close()\n`,
      { mode: 0o755 },
    );
    expect(invoke(session(f, "apply", { actionId: "pinned-add" }))).toMatchObject({ code: 0 });
    expect(await lstat(hostile).catch(() => null)).toBeNull();
    expect(await lstat(installed)).not.toBeNull();
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0 });
    expect(await lstat(installed).catch(() => null)).toBeNull();

    await writeFile(commandPath, safeCommand, { mode: 0o755 });
    const redirected = await fixture([
      { codexCommand: command, id: "redirect-add", kind: "plugin-add", pluginId: "pinned" },
    ]);
    expect(invoke(redirected.prepare).code).toBe(0);
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3\nopen(${JSON.stringify(hostile)},"w").close()\n`,
      { mode: 0o755 },
    );
    const statePath = join(redirected.workspace, "state.json");
    const forged = JSON.parse(await readFile(statePath, "utf8"));
    forged.payload.records[0].pinnedPath = commandPath;
    forged.sha256 = createHmac("sha256", redirected.token)
      .update(canonical(forged.payload))
      .digest("hex");
    await writeFile(statePath, canonical(forged));
    expect(invoke(session(redirected, "apply", { actionId: "redirect-add" }))).toMatchObject({
      code: 64,
      body: { message: "invalid transaction state" },
    });
    expect(await lstat(hostile).catch(() => null)).toBeNull();
  });

  it("rejects malformed or runtime-oversized Codex plugin list output", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-list-schema-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const installed = join(root, "installed");
    const mode = join(root, "mode");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,sys
op=sys.argv[2]
if op=="list":
    mode=open(${JSON.stringify(mode)}).read()
    if mode=="malformed": print(json.dumps({"installed":[{"pluginId":"schema","installed":False}],"available":[{"pluginId":"schema","installed":False}],"extra":[]}))
    elif mode=="huge": sys.stdout.write("x"*(5*1024*1024))
    else: print(json.dumps({"installed":[{"pluginId":"schema","installed":True}] if os.path.exists(${JSON.stringify(installed)}) else [],"available":[]}))
elif op=="add": open(${JSON.stringify(installed)},"w").close()
elif op=="remove": os.unlink(${JSON.stringify(installed)})
`,
    );
    await chmod(commandPath, 0o755);
    await writeFile(mode, "malformed");
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "schema-add", kind: "plugin-add", pluginId: "schema" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    expect(invoke(session(f, "apply", { actionId: "schema-add" })).code).toBe(0);
    expect(invoke(session(f, "abort"))).toMatchObject({
      code: 64,
      body: { message: "invalid Codex plugin reconciliation output" },
    });
    await writeFile(mode, "huge");
    expect(invoke(session(f, "abort"))).toMatchObject({
      code: 64,
      body: { message: "Codex plugin reconciliation output exceeds limit" },
    });
    await writeFile(mode, "normal");
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0 });
  });

  it("kills a plugin-list descendant that keeps stdout open after its parent exits", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-list-daemon-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const installed = join(root, "installed");
    const daemonMode = join(root, "daemon-mode");
    const orphan = join(root, "orphan");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,subprocess,sys
op=sys.argv[2]
if op=="list":
    if os.path.exists(${JSON.stringify(daemonMode)}):
        subprocess.Popen([sys.executable,"-c",${JSON.stringify(`import time;time.sleep(2);open(${JSON.stringify(orphan)},"w").close()`)}],stdout=sys.stdout)
    print(json.dumps({"installed":[{"pluginId":"daemon","installed":True}] if os.path.exists(${JSON.stringify(installed)}) else [],"available":[]}))
elif op=="add": open(${JSON.stringify(installed)},"w").close()
elif op=="remove": os.unlink(${JSON.stringify(installed)})
`,
    );
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "daemon-add", kind: "plugin-add", pluginId: "daemon" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    expect(invoke(session(f, "apply", { actionId: "daemon-add" })).code).toBe(0);
    await writeFile(daemonMode, "1");
    expect(invoke(session(f, "abort"))).toMatchObject({
      code: 64,
      body: { message: "Codex plugin reconciliation pipe remained open" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await lstat(orphan).catch(() => null)).toBeNull();
    await rm(daemonMode);
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0 });
  });

  it("persists per-plugin compensation progress across rollback retries", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-progress-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const log = join(root, "plugin.log");
    const failed = join(root, "failed-once");
    const installedFirst = join(root, "installed-first");
    const installedSecond = join(root, "installed-second");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,sys
op=sys.argv[2]; plugin=sys.argv[3]
paths={"first":${JSON.stringify(installedFirst)},"second":${JSON.stringify(installedSecond)}}
if op=="list":
    print(json.dumps({"installed":[{"pluginId":p,"installed":True} for p,path in paths.items() if os.path.exists(path)],"available":[]})); sys.exit()
with open(${JSON.stringify(log)},"a") as f: f.write(op+":"+plugin+"\\n")
if op=="add": open(paths[plugin],"w").close()
if op=="remove" and plugin=="first" and not os.path.exists(${JSON.stringify(failed)}):
    open(${JSON.stringify(failed)},"w").close(); sys.exit(9)
if op=="remove": os.unlink(paths[plugin])
`,
    );
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "first-add", kind: "plugin-add", pluginId: "first" },
      { codexCommand: command, id: "second-add", kind: "plugin-add", pluginId: "second" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    const preparedState = JSON.parse(
      await readFile(join(f.workspace, "state.json"), "utf8"),
    ).payload;
    expect(preparedState.records[0].pinned).toBe(preparedState.records[1].pinned);
    expect(
      (await readdir(join(f.home, `.ccm-push-state-${f.token}`))).filter((name) =>
        name.startsWith("plugin-"),
      ),
    ).toHaveLength(1);
    expect(invoke(session(f, "apply", { actionId: "first-add" })).code).toBe(0);
    expect(invoke(session(f, "apply", { actionId: "second-add" })).code).toBe(0);
    expect(invoke(session(f, "abort"))).toMatchObject({
      code: 64,
      body: { message: "Codex plugin remove failed; retained backups preserved" },
    });
    const firstState = JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8")).payload;
    expect(firstState.plugins).toMatchObject([
      { id: "first", original: command, remove: "removing" },
      { id: "second", original: command, remove: "complete" },
    ]);
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0, body: { status: "aborted" } });
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.filter((line) => line === "remove:second")).toHaveLength(1);
    expect(lines.filter((line) => line === "remove:first")).toHaveLength(2);
  });

  it("reconciles an already-absent plugin after crashing between remove success and state save", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-crash-window-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const installed = join(root, "installed");
    const absentQuery = join(root, "absent-query");
    const removes = join(root, "removes");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,sys,time
op=sys.argv[2]
if op=="list":
    present=os.path.exists(${JSON.stringify(installed)})
    if not present: open(${JSON.stringify(absentQuery)},"w").close(); time.sleep(0.3)
    print(json.dumps({"installed":[{"pluginId":"crashy","installed":True}] if present else [],"available":[]}))
elif op=="add": open(${JSON.stringify(installed)},"w").close()
elif op=="remove":
    if not os.path.exists(${JSON.stringify(installed)}): sys.exit(17)
    os.unlink(${JSON.stringify(installed)})
    with open(${JSON.stringify(removes)},"a") as f: f.write("remove\\n")
`,
    );
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "crashy-add", kind: "plugin-add", pluginId: "crashy" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    expect(invoke(session(f, "apply", { actionId: "crashy-add" })).code).toBe(0);
    const payload = Buffer.from(canonical(runtimeRequest(session(f, "abort")))).toString("base64");
    const child = spawn(python, launchArgs(payload), { stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(absentQuery);
    child.kill("SIGKILL");
    await new Promise<number | null>((resolve) => child.on("close", resolve));
    const interrupted = JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8")).payload;
    expect(interrupted.plugins[0]).toMatchObject({ remove: "removing" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0, body: { status: "aborted" } });
    expect(await readFile(removes, "utf8")).toBe("remove\n");
  });

  it("kills the plugin process group on SIGTERM without orphaned late mutation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-plugin-signal-")));
    roots.push(root);
    const commandPath = join(root, "fake-codex.py");
    const started = join(root, "started");
    const orphan = join(root, "orphan");
    const installed = join(root, "installed");
    await writeFile(
      commandPath,
      `#!/usr/bin/env python3
import json,os,subprocess,sys,time
if sys.argv[2]=="list":
    print(json.dumps({"installed":[{"pluginId":"signal","installed":True}] if os.path.exists(${JSON.stringify(installed)}) else [],"available":[]})); sys.exit()
if sys.argv[2]=="add":
    open(${JSON.stringify(installed)},"w").close()
    open(${JSON.stringify(started)},"w").close()
    subprocess.Popen([sys.executable,"-c",${JSON.stringify(`import time;time.sleep(0.5);open(${JSON.stringify(orphan)},"w").close()`)}])
    time.sleep(10)
if sys.argv[2]=="remove": os.unlink(${JSON.stringify(installed)})
`,
    );
    await chmod(commandPath, 0o755);
    const command = await realpath(commandPath);
    const f = await fixture([
      { codexCommand: command, id: "signal-add", kind: "plugin-add", pluginId: "signal" },
    ]);
    expect(invoke(f.prepare).code).toBe(0);
    const payload = Buffer.from(
      canonical(runtimeRequest(session(f, "apply", { actionId: "signal-add" }))),
    ).toString("base64");
    const child = spawn(python, launchArgs(payload), { stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(started);
    child.kill("SIGTERM");
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exit).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await lstat(orphan).catch(() => null)).toBeNull();
    expect(invoke(session(f, "abort"))).toMatchObject({ code: 0, body: { status: "aborted" } });
  });

  it("holds one HOME lock across workspaces", async () => {
    const action = { id: "one", kind: "overlay-group", logicalGroup: "codex/config.toml" };
    const first = await fixture([action], { "codex/config.toml": "one\n" });
    await mkdir(join(first.home, ".codex"));
    const second = await fixture([action], { "codex/config.toml": "two\n" });
    const manifestPath = join(second.workspace, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.home = first.home;
    const bytes = canonical(manifest);
    await writeFile(manifestPath, bytes);
    second.prepare.manifestSha256 = sha(bytes);
    second.prepare.home = first.home;
    expect(invoke(first.prepare).code).toBe(0);
    expect(invoke(second.prepare)).toMatchObject({
      code: 64,
      body: { message: "another push transaction holds the lock" },
    });
    expect(invoke(session(first, "abort")).code).toBe(0);
  });
});
