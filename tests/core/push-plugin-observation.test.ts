import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES } from "../../src/core/push-observation.ts";
import {
  buildPluginObservationProgram,
  MAX_PLUGIN_CATALOG_BYTES,
} from "../../src/core/push-plugin-observation.ts";
import { runProcess } from "../../src/utils/process.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function observe(raw: string, compactLimit = MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES) {
  const root = await mkdtemp(join(tmpdir(), "ccm-plugin-catalog-"));
  roots.push(root);
  const catalog = join(root, "catalog.json");
  const command = join(root, "codex");
  await writeFile(catalog, raw);
  await writeFile(command, '#!/bin/sh\ncat "$CCM_CATALOG"\n', { mode: 0o755 });
  return runProcess("python3", ["-I", "-c", buildPluginObservationProgram(compactLimit), command], {
    env: { ...process.env, CCM_CATALOG: catalog },
    nothrow: true,
  });
}

describe("bounded plugin catalog normalization", () => {
  it("handles 20,000 plugins and multi-megabyte metadata, deduplicating identities and ignoring new metadata fields", async () => {
    const available = Array.from({ length: 20_000 }, (_, i) => ({
      pluginId: `plugin-${i}@market`,
      description: "metadata ".repeat(48),
    }));
    const raw = JSON.stringify({
      installed: [{ pluginId: "installed@market" }],
      available: [...available, available[0]],
      futureMetadata: { version: 2 },
    });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
    const result = await observe(raw);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const fields = result.stdout.trim().split("\t");
    expect(fields.slice(0, 2)).toEqual(["PLUGINS", "ok"]);
    const compact = Buffer.from(fields[2] as string, "base64");
    expect(compact.byteLength).toBeLessThan(MAX_PUSH_OBSERVATION_PLUGIN_LIST_BYTES);
    const parsed = JSON.parse(compact.toString());
    expect(parsed.available).toHaveLength(20_000);
    expect(parsed.installed).toEqual([{ pluginId: "installed@market" }]);
    expect(compact.toString()).not.toContain("description");
    expect(compact.toString()).not.toContain("futureMetadata");
  });

  it.each([
    "broken JSON",
    JSON.stringify({ installed: [], available: [{ pluginId: "bad id" }] }),
    JSON.stringify({ installed: {}, available: [] }),
    JSON.stringify({ installed: [], available: [null] }),
    JSON.stringify({ installed: [], available: [{ pluginId: `${"x".repeat(513)}@market` }] }),
  ])("rejects malformed catalogs without echoing their contents", async (raw) => {
    const result = await observe(raw);
    expect(result).toMatchObject({ exitCode: 49, stdout: "", stderr: "" });
  });

  it("enforces the raw input budget before parsing or transporting a large entry", async () => {
    const result = await observe("x".repeat(MAX_PLUGIN_CATALOG_BYTES + 1));
    expect(result).toMatchObject({ exitCode: 47, stdout: "", stderr: "" });
  });

  it("enforces the independent compact identity budget", async () => {
    const result = await observe(
      JSON.stringify({ installed: [], available: [{ pluginId: "a@market" }] }),
      16,
    );
    expect(result).toMatchObject({ exitCode: 45, stdout: "", stderr: "" });
  });

  it.each([
    false,
    true,
  ])("stops a hung CLI and its descendants (external cancellation: %s)", async (cancel) => {
    const root = await mkdtemp(join(tmpdir(), "ccm-plugin-timeout-"));
    roots.push(root);
    const command = join(root, "codex");
    const pidFile = join(root, "child.pid");
    await writeFile(command, '#!/bin/sh\nsleep 30 &\nprintf "%s" "$!" > "$CCM_CHILD_PID"\nwait\n', {
      mode: 0o755,
    });
    const result = await runProcess(
      "python3",
      ["-I", "-c", buildPluginObservationProgram(1024, cancel ? 30 : 0.5), command],
      {
        env: { ...process.env, CCM_CHILD_PID: pidFile },
        nothrow: true,
        timeoutMs: cancel ? 1_000 : 5_000,
      },
    );
    expect(result).toMatchObject({ exitCode: 48, stdout: "", stderr: "" });
    const pid = (await readFile(pidFile, "utf8")).trim();
    const child = await runProcess("ps", ["-o", "stat=", "-p", pid], { nothrow: true });
    expect(child.exitCode !== 0 || child.stdout.trim().startsWith("Z")).toBe(true);
  });
});
