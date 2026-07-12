import { describe, expect, it } from "vitest";
import {
  canonicalInventory,
  groupManagedTopLevelEntries,
  type InventoryEntry,
  inventoryFingerprint,
  inventoryFromFileEntries,
  overlayInventories,
  postInventoryFingerprint,
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

  it("hashes virtual and symlink bindings without serializing raw targets", async () => {
    const target = "../../private/secret-target";
    const inventory = await inventoryFromFileEntries([
      {
        sourcePath: "/unused",
        relativePath: "claude/skills/demo",
        isSymlink: true,
        originalSymlinkTarget: target,
      },
    ]);
    expect(JSON.stringify(inventory)).not.toContain(target);
    expect(inventory[0]?.sha256).toHaveLength(64);
  });

  it("rejects portable collisions", () => {
    expect(() =>
      canonicalInventory([entry("codex/skills/Demo/x"), entry("codex/skills/demo/y")]),
    ).toThrow("Non-portable inventory path collision");
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
    expect(postInventoryFingerprint(target, incoming)).toBe(
      inventoryFingerprint(overlay.map(({ entry: item }) => item)),
    );
  });

  it("groups at managed action granularity and excludes anything callers omit", () => {
    const managed = [
      entry("codex/rules/a.md"),
      entry("codex/rules/b.md"),
      entry("shared/agents/skills/demo/SKILL.md"),
    ];
    expect(groupManagedTopLevelEntries(managed).map((group) => group.path)).toEqual([
      "codex/rules",
      "shared/agents/skills",
    ]);
  });
});
