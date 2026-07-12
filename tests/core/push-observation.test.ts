import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InventoryEntry } from "../../src/core/inventory.ts";
import {
  buildRemotePushObservationProbe,
  observeRemotePushTarget,
  parseRemotePushObservation,
  PUSH_OBSERVATION_TIMEOUT_MS,
} from "../../src/core/push-observation.ts";
import { runProcess } from "../../src/utils/process.ts";

const incoming = (path: string): InventoryEntry => ({
  path,
  type: "file",
  mode: 0o644,
  size: 1,
  sha256: "a".repeat(64),
});
const e = (value: string) => Buffer.from(value).toString("base64");
const envelope = (...records: string[]) =>
  [
    "CCM_PUSH_OBSERVATION\t1",
    `HOME\t${e("/home/me")}`,
    `OS\t${e("Linux")}`,
    `ARCH\t${e("x86_64")}`,
    "GUI\tfalse",
    ...records,
    "END",
    "",
  ].join("\n");

describe("remote push observation", () => {
  it("allows a sixty-second managed-tree scan", () => {
    expect(PUSH_OBSERVATION_TIMEOUT_MS).toBe(60_000);
  });
  it("uses exactly one argv SSH transport call and does not invoke codex", async () => {
    const calls: unknown[][] = [];
    const observed = await observeRemotePushTarget({
      host: "me@example.com",
      incoming: [],
      transport: {
        async run(...args) {
          calls.push(args);
          return { stdout: envelope(), stderr: "", exitCode: 0 };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(expect.stringMatching(/^sh -c /));
    expect(String(calls[0]?.[1])).not.toMatch(/command -v ['"]?codex/);
    expect(JSON.stringify(observed)).not.toContain("example.com");
  });

  it("runs read-only against spaces, unicode, and symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm push observe "));
    const dir = join(home, ".codex", "skills");
    await mkdir(join(dir, "ü space"), { recursive: true });
    await writeFile(join(dir, "ü space", "name"), "hello");
    await symlink("ü space", join(dir, "link"));
    const before = await readFile(join(dir, "ü space", "name"));
    const probe = buildRemotePushObservationProbe([incoming("codex/skills/new")]);
    const result = await runProcess("sh", ["-c", probe], {
      env: { ...process.env, HOME: home },
      maxBuffer: 64 * 1024 * 1024,
    });
    const observed = parseRemotePushObservation(result.stdout, [incoming("codex/skills/new")]);
    expect(observed.inventory.map(({ path, type }) => [path, type])).toEqual([
      ["codex/skills/link", "symlink"],
      ["codex/skills/ü space/name", "file"],
    ]);
    expect(await readFile(join(dir, "ü space", "name"))).toEqual(before);
  });

  it("preserves symlink target trailing newlines and recognizes any execute bit", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-mode-"));
    const dir = join(home, ".codex", "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "special-only"), "x", { mode: 0o1400 });
    await writeFile(join(dir, "special-executable"), "x", { mode: 0o1750 });
    await symlink("target\n\n", join(dir, "newline-link"));
    const probe = buildRemotePushObservationProbe([incoming("codex/skills/new")]);
    const result = await runProcess("sh", ["-c", probe], { env: { ...process.env, HOME: home } });
    const observed = parseRemotePushObservation(result.stdout, [incoming("codex/skills/new")]);
    expect(observed.inventory.find((x) => x.path.endsWith("special-only"))?.mode).toBe(0o644);
    expect(observed.inventory.find((x) => x.path.endsWith("special-executable"))?.mode).toBe(0o755);
    expect(observed.inventory.find((x) => x.path.endsWith("newline-link"))).toMatchObject({
      size: Buffer.byteLength("target\n\n"),
      sha256: createHash("sha256")
        .update("ccm:inventory:symlink-target\0")
        .update("target\n\n")
        .digest("hex"),
    });
  });

  it("inventories current-size plugin packs above the capture cap and skips .git", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-pack-"));
    const root = join(home, ".codex", ".tmp", "plugins");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "pack"), "");
    await truncate(join(root, "pack"), 5 * 1024 * 1024);
    await writeFile(join(root, ".git", "large-pack"), "ignored");
    const wanted = incoming("codex/.tmp/plugins/pack");
    const result = await runProcess("sh", ["-c", buildRemotePushObservationProbe([wanted])], {
      env: { ...process.env, HOME: home },
    });
    const observed = parseRemotePushObservation(result.stdout, [wanted]);
    expect(observed.inventory).toHaveLength(1);
    expect(observed.inventory[0]?.size).toBe(5 * 1024 * 1024);
  });

  it("skips provider never-migrate subtrees", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-never-"));
    const root = join(home, ".codex", "skills");
    await mkdir(join(root, ".system"), { recursive: true });
    await writeFile(join(root, ".system", "private"), "ignored");
    await writeFile(join(root, "kept"), "yes");
    const wanted = incoming("codex/skills/new");
    const result = await runProcess("sh", ["-c", buildRemotePushObservationProbe([wanted])], {
      env: { ...process.env, HOME: home },
    });
    expect(
      parseRemotePushObservation(result.stdout, [wanted]).inventory.map((entry) => entry.path),
    ).toEqual(["codex/skills/kept"]);
  });

  it("uses a dash sentinel for missing commands and binds paths and HOME into state", () => {
    const query = { commandNames: ["missing"] };
    const missing = `CMD\t${e("missing")}\t-`;
    const first = parseRemotePushObservation(envelope(missing), [], query);
    expect(first.facts.commandPaths.get("missing")).toBeNull();
    const resolved = `CMD\t${e("missing")}\t${e("/usr/bin/missing")}`;
    expect(parseRemotePushObservation(envelope(resolved), [], query).pushStateFingerprint).not.toBe(
      first.pushStateFingerprint,
    );
    expect(
      parseRemotePushObservation(
        envelope(missing).replace(e("/home/me"), e("/home/else")),
        [],
        query,
      ).pushStateFingerprint,
    ).not.toBe(first.pushStateFingerprint);
  });

  it("rejects non-canonical absolute paths and unsolicited or duplicate skills", () => {
    expect(() =>
      parseRemotePushObservation(envelope().replace(e("/home/me"), e("//home/me")), []),
    ).toThrow("remote HOME");
    expect(() => parseRemotePushObservation(envelope(`SKILL\t${e("demo")}`), [])).toThrow(
      "Unexpected SKILL",
    );
    expect(() =>
      parseRemotePushObservation(envelope(`SKILL\t${e("demo")}`, `SKILL\t${e("demo")}`), [], {
        sharedSkillNames: true,
      }),
    ).toThrow("Invalid SKILL");
  });

  it("captures exact bounded bytes and validates their hash", () => {
    const bytes = Buffer.from("héllo\n");
    const record = `CAPTURE\t${e("/home/me/.claude.json")}\t${bytes.length}\t${createHash("sha256").update(bytes).digest("hex")}\t${bytes.toString("base64")}`;
    const parsed = parseRemotePushObservation(envelope(record), [], {
      capturePaths: ["/home/me/.claude.json"],
    });
    expect(Buffer.from(parsed.facts.captures.get("/home/me/.claude.json") ?? []).toString()).toBe(
      "héllo\n",
    );
    expect(() =>
      parseRemotePushObservation(
        envelope(record.replace(/\t[0-9a-f]{64}\t/, `\t${"0".repeat(64)}\t`)),
        [],
        {
          capturePaths: ["/home/me/.claude.json"],
        },
      ),
    ).toThrow("Invalid CAPTURE");
  });

  it("resolves logical capture IDs only after learning remote HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-observe-capture-id-"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "claude\n");
    await writeFile(join(home, ".codex", "config.toml"), "codex\n");
    const queries = { captureIds: ["claude-mcp", "codex-config"] as const };
    const result = await runProcess("sh", ["-c", buildRemotePushObservationProbe([], queries)], {
      env: { ...process.env, HOME: home },
    });
    const observed = parseRemotePushObservation(result.stdout, [], queries);
    expect(Buffer.from(observed.facts.captures.get("claude-mcp") ?? []).toString()).toBe(
      "claude\n",
    );
    expect(Buffer.from(observed.facts.captures.get("codex-config") ?? []).toString()).toBe(
      "codex\n",
    );
  });

  it.each([
    ["unknown record", envelope("WAT\teA==")],
    ["duplicate singleton", envelope(`HOME\t${e("/tmp")}`)],
    ["bad base64", envelope("SKILL\t***")],
    ["trailing junk", `${envelope()}junk`],
    [
      "unexpected prefix",
      envelope(`ENTRY\t${e("claude/secret")}\tfile\t644\t0\t${"a".repeat(64)}`),
    ],
    ["invalid type", envelope(`ENTRY\t${e("codex/skills/x")}\tdir\t644\t0\t${"a".repeat(64)}`)],
  ])("rejects %s", (_name, stdout) => {
    expect(() =>
      parseRemotePushObservation(stdout, [incoming("codex/skills/new")], {
        sharedSkillNames: true,
      }),
    ).toThrow();
  });
});
