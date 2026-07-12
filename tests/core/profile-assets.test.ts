import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureProfileAssets,
  MAX_PROFILE_ASSET_BYTES,
  readProfileAssetBounded,
} from "../../src/core/profile-assets.ts";
import type { HostProfile } from "../../src/types/index.ts";

function profile(claude_md?: string, agents_md?: string): HostProfile {
  return {
    host: "user@host",
    claude_md,
    agents_md,
    claude: {},
    codex: { plugin_policies: {} },
  };
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccm-profile-assets-"));
  await mkdir(join(dir, "profiles", "devbox"), { recursive: true });
  return realpath(dir);
}

describe("profile assets", () => {
  it("captures contained UTF-8 replacement bytes and hashes", async () => {
    const dir = await fixture();
    const claude = "profiles/devbox/CLAUDE.md";
    const agents = "profiles/devbox/AGENTS.md";
    await writeFile(join(dir, claude), "claude instructions\n");
    await writeFile(join(dir, agents), "agent instructions\n");
    const assets = await captureProfileAssets(profile(claude, agents), dir);
    expect(assets.map((asset) => asset.kind)).toEqual(["claude_md", "agents_md"]);
    expect(assets.map((asset) => asset.destinationPath)).toEqual([
      "claude/CLAUDE.md",
      "codex/AGENTS.md",
    ]);
    expect(assets[0]?.bytes.toString()).toBe("claude instructions\n");
    expect(assets[0]?.size).toBe(Buffer.byteLength("claude instructions\n"));
    expect(assets[0]?.sha256).toBe(
      createHash("sha256").update("claude instructions\n").digest("hex"),
    );
  });

  it.each([
    "/tmp/CLAUDE.md",
    "../CLAUDE.md",
    ".",
    "profiles//CLAUDE.md",
    "bad\nname",
  ])("rejects unsafe or uncontained path %s", async (path) => {
    const dir = await fixture();
    await expect(captureProfileAssets(profile(path), dir)).rejects.toThrow();
  });

  it("rejects symlink leaves and ancestors", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "real.md"), "safe");
    await symlink(join(dir, "real.md"), join(dir, "profiles", "leaf.md"));
    await symlink(join(dir, "profiles", "devbox"), join(dir, "linked-dir"));
    await expect(captureProfileAssets(profile("profiles/leaf.md"), dir)).rejects.toThrow("symlink");
    await expect(captureProfileAssets(profile("linked-dir/CLAUDE.md"), dir)).rejects.toThrow(
      "symlink",
    );
  });

  it("rejects a symlinked config directory beneath a writable lexical parent", async () => {
    const dir = await fixture();
    const trusted = join(dir, "trusted-config");
    const writable = join(dir, "writable");
    await mkdir(trusted);
    await mkdir(writable);
    await writeFile(join(trusted, "secret.md"), "outside");
    await chmod(writable, 0o777);
    const linkedConfig = join(writable, "config-link");
    await symlink(trusted, linkedConfig);
    await expect(captureProfileAssets(profile("secret.md"), linkedConfig)).rejects.toThrow();
  });

  it("accepts a config directory beneath a sticky world-writable ancestor", async () => {
    const dir = await fixture();
    const sticky = join(dir, "sticky");
    const configDir = join(sticky, "config");
    await mkdir(sticky);
    await chmod(sticky, 0o1777);
    await mkdir(configDir);
    await writeFile(join(configDir, "CLAUDE.md"), "safe");
    const assets = await captureProfileAssets(profile("CLAUDE.md"), configDir);
    expect(assets[0]?.bytes.toString()).toBe("safe");
  });

  it("rejects a config directory beneath a non-sticky world-writable ancestor", async () => {
    const dir = await fixture();
    const writable = join(dir, "plain-writable");
    const configDir = join(writable, "config");
    await mkdir(writable);
    await chmod(writable, 0o777);
    await mkdir(configDir);
    await writeFile(join(configDir, "CLAUDE.md"), "unsafe ancestry");
    await expect(captureProfileAssets(profile("CLAUDE.md"), configDir)).rejects.toThrow(
      "group/world-writable ancestors",
    );
  });

  it("rejects untrusted-writable asset ancestors before opening a leaf", async () => {
    const dir = await fixture();
    const parent = join(dir, "profiles", "devbox");
    await writeFile(join(parent, "CLAUDE.md"), "inside");
    await chmod(parent, 0o777);
    await expect(captureProfileAssets(profile("profiles/devbox/CLAUDE.md"), dir)).rejects.toThrow(
      "trusted non-symlink directories",
    );
  });

  it("bounds reads when an already-open regular file grows", async () => {
    const dir = await fixture();
    const path = join(dir, "growing.md");
    await writeFile(path, "small");
    const handle = await open(path, "r");
    try {
      await writeFile(path, Buffer.alloc(MAX_PROFILE_ASSET_BYTES + 1, 0x61));
      await expect(readProfileAssetBounded(handle)).rejects.toThrow("exceeds");
    } finally {
      await handle.close();
    }
  });

  it("rejects directories, invalid UTF-8, and files over 1 MiB", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "invalid.md"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(dir, "large.md"), Buffer.alloc(MAX_PROFILE_ASSET_BYTES + 1, 0x61));
    await expect(captureProfileAssets(profile("profiles"), dir)).rejects.toThrow("regular file");
    await expect(captureProfileAssets(profile("invalid.md"), dir)).rejects.toThrow("valid UTF-8");
    await expect(captureProfileAssets(profile("large.md"), dir)).rejects.toThrow("exceeds");
  });

  it("accepts an asset exactly at the size limit and an asset-free profile", async () => {
    const dir = await fixture();
    await writeFile(join(dir, "max.md"), Buffer.alloc(MAX_PROFILE_ASSET_BYTES, 0x61));
    expect((await captureProfileAssets(profile("max.md"), dir))[0]?.bytes).toHaveLength(
      MAX_PROFILE_ASSET_BYTES,
    );
    expect(await captureProfileAssets(profile(), dir)).toEqual([]);
  });
});
