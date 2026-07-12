import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InventoryEntry } from "../../src/core/inventory.ts";
import {
  buildRemotePushObservationProbe,
  observeRemotePushTarget,
  parseRemotePushObservation,
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
    expect(calls[0]?.[1]).toEqual(["sh", "-c", expect.any(String)]);
    expect(String((calls[0]?.[1] as string[])[2])).not.toMatch(/command -v ['"]?codex/);
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
