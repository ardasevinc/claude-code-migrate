import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  type InventoryEntry,
  inventoryFingerprint,
  inventoryFromFileEntries,
  overlayInventories,
  overlayInventoryFingerprint,
  symlinkInventoryEntry,
} from "../../src/core/inventory.ts";

const entry = (path: string, overrides: Partial<InventoryEntry> = {}): InventoryEntry => ({
  path,
  type: "file",
  mode: 0o644,
  size: 3,
  sha256: "a".repeat(64),
  ...overrides,
});

describe("managed state inventory", () => {
  it("has an order- and source-root-independent tree fingerprint", async () => {
    const first = await inventoryFromFileEntries([
      {
        sourcePath: "/private/a",
        relativePath: "codex/config.toml",
        isSymlink: false,
        mcpServersOnly: "a",
      },
      {
        sourcePath: "/private/b",
        relativePath: "claude/settings.json",
        isSymlink: false,
        mcpServersOnly: "b",
      },
    ]);
    const second = await inventoryFromFileEntries([
      {
        sourcePath: "/elsewhere/b",
        relativePath: "claude/settings.json",
        isSymlink: false,
        mcpServersOnly: "b",
      },
      {
        sourcePath: "/elsewhere/a",
        relativePath: "codex/config.toml",
        isSymlink: false,
        mcpServersOnly: "a",
      },
    ]);
    expect(inventoryFingerprint(first)).toBe(inventoryFingerprint(second));
    expect(JSON.stringify(first)).not.toContain("/private");
  });

  it("is sensitive to path, bytes, mode, and symlink identity", () => {
    const base = [entry("codex/config.toml")];
    for (const changed of [
      [entry("codex/.ccm/config.toml")],
      [entry("codex/config.toml", { sha256: "b".repeat(64) })],
      [entry("codex/config.toml", { mode: 0o755 })],
      [entry("codex/config.toml", { type: "symlink" })],
    ])
      expect(inventoryFingerprint(changed)).not.toBe(inventoryFingerprint(base));
  });

  it("models collected symlink provenance as archived regular-file bytes", async () => {
    const target = "../../private/secret-target";
    const inventory = await inventoryFromFileEntries([
      {
        sourcePath: "/unused",
        relativePath: "claude/skills/demo/SKILL.md",
        isSymlink: true,
        originalSymlinkTarget: target,
        mcpServersOnly: "",
      },
    ]);
    expect(inventory[0]).toMatchObject({ type: "file", mode: 0o644, size: 0 });
    expect(JSON.stringify(inventory)).not.toContain(target);
    expect(inventory[0]?.sha256).toHaveLength(64);
  });

  it("domain-separates logical symlink targets without retaining them", () => {
    const target = "../../private/secret-target";
    const logical = symlinkInventoryEntry("claude/skills/demo", target);
    expect(logical.type).toBe("symlink");
    expect(JSON.stringify(logical)).not.toContain(target);
    expect(logical.sha256).not.toBe(createHash("sha256").update(target).digest("hex"));
  });

  it("rejects portable collisions", () => {
    expect(() =>
      canonicalInventory([entry("codex/skills/Demo/x"), entry("codex/skills/demo/y")]),
    ).toThrow("Non-portable inventory path collision");
  });

  it.each([
    [entry("codex/auth.json"), "not managed"],
    [entry("codex/config.toml", { mode: 0o600 as 0o644 }), "mode"],
    [entry("codex/config.toml", { size: -1 }), "size"],
    [entry("codex/config.toml", { sha256: "A".repeat(64) }), "sha256"],
  ])("rejects malformed entries", (invalid, message) => {
    expect(() => canonicalInventory([invalid])).toThrow(message);
  });

  it("rejects file ancestor conflicts", () => {
    expect(() => canonicalInventory([entry("codex/rules"), entry("codex/rules/local.md")])).toThrow(
      "file ancestor conflict",
    );
  });

  it("overlays incoming entries while preserving target-only entries", () => {
    const target = [entry("codex/config.toml"), entry("codex/rules/local.md")];
    const incoming = [
      entry("codex/config.toml", { sha256: "b".repeat(64) }),
      entry("codex/.ccm/new", { size: 1 }),
    ];
    const overlay = overlayInventories(target, incoming);
    expect(overlay.map(({ entry: item, disposition }) => [item.path, disposition])).toEqual([
      ["codex/.ccm/new", "create"],
      ["codex/config.toml", "update"],
      ["codex/rules/local.md", "preserve"],
    ]);
    expect(overlayInventoryFingerprint(target, incoming)).toBe(
      inventoryFingerprint(overlay.map(({ entry: item }) => item)),
    );
  });

  it.each([
    [[entry("codex/rules")], [entry("codex/rules/local.md")]],
    [[entry("codex/rules/local.md")], [entry("codex/rules")]],
  ])("rejects impossible parent-file overlays in either direction", (target, incoming) => {
    expect(() => overlayInventories(target, incoming)).toThrow("file ancestor conflict");
  });

  it("groups at managed action granularity and excludes anything callers omit", () => {
    const managed = [
      entry("codex/rules/a.md"),
      entry("codex/rules/b.md"),
      entry("codex/.tmp/plugins/demo/file"),
      entry("codex/.tmp/plugins.sha"),
      entry("claude/.mcp-config.json"),
      entry("shared/agents/skills/demo/SKILL.md"),
    ];
    expect(groupManagedTopLevelEntries(managed).map((group) => group.path)).toEqual([
      "claude/.mcp-config.json",
      "codex/.tmp/plugins",
      "codex/.tmp/plugins.sha",
      "codex/rules",
      "shared/agents/skills",
    ]);
  });
});
