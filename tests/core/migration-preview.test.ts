import { describe, expect, it } from "vitest";
import { describeConfigChanges } from "../../src/core/config-preview.ts";
import type { InventoryEntry } from "../../src/core/inventory.ts";
import type { MigrationPlan } from "../../src/core/migration-plan.ts";
import {
  registerMigrationPreview,
  renderMigrationPreview,
} from "../../src/core/migration-preview.ts";

const entry = (path: string, sha256 = "a".repeat(64)): InventoryEntry => ({
  path,
  sha256,
  size: 1,
  type: "file",
  mode: 0o644,
});
const planned = (status = "ready") => ({
  plan: {
    kind: "push",
    providers: ["codex"],
    status,
    id: "plan_opaque",
    actions: [],
  } as unknown as MigrationPlan,
});

describe("human migration previews", () => {
  it("explains settings and MCP/plugin changes without revealing credentials or arbitrary values", () => {
    const before = Buffer.from(
      'model = "old-model"\napi_key = "OLD-SECRET"\n[mcp_servers.exa]\ncommand = "old-secret-command"\n[plugins."demo@market"]\nenabled = true\n',
    );
    const after = Buffer.from(
      'model = "new-model"\napi_key = "NEW-SECRET"\n[mcp_servers.exa]\ncommand = "new-secret-command"\n[plugins."demo@market"]\nenabled = false\n',
    );
    const output = describeConfigChanges(before, after).join("\n");
    expect(output).toContain("Model: old-model -> new-model");
    expect(output).toContain("Update setting api_key");
    expect(output).toContain("Update mcp server exa (command)");
    expect(output).toContain("Update plugin demo@market (disabled)");
    expect(output).not.toMatch(/SECRET|secret-command/);
  });

  it("compares semantics rather than TOML order and reports removed settings", () => {
    expect(
      describeConfigChanges(
        Buffer.from('model="x"\n[features]\na=true\nb=false\n'),
        Buffer.from('model="x"\n[features]\nb=false\na=true\n'),
      ),
    ).toEqual([]);
    expect(
      describeConfigChanges(
        Buffer.from('notify=["private-command"]\n'),
        Buffer.from('model="x"\n'),
      ),
    ).toContain("Remove notification command");
  });

  it("counts only actual changes, names skill bundles, and keeps the public JSON unchanged", () => {
    const result = planned();
    const original = JSON.stringify(result);
    registerMigrationPreview(result, {
      target: "devbox",
      before: [entry("codex/AGENTS.md"), entry("shared/agents/skills/target-only/SKILL.md")],
      after: [
        entry("codex/AGENTS.md", "b".repeat(64)),
        entry("shared/agents/skills/target-only/SKILL.md"),
        entry("shared/agents/skills/new-skill/SKILL.md"),
      ],
      settings: ["Reasoning effort: low -> high"],
      effects: ["Install demo@market"],
    });
    const human = renderMigrationPreview(result);
    expect(human).toContain("Would change 2 files (1 new, 1 updated) and install 1 plugin.");
    expect(human).toContain("Shared skills: 1 new (new-skill)");
    expect(human).toContain("1 observed files unchanged");
    expect(human).not.toMatch(/target-only|plan_opaque|materialize|post-commit/);
    expect(renderMigrationPreview(result, { verbose: true })).toContain(
      "Add ~/.agents/skills/new-skill/SKILL.md",
    );
    expect(JSON.stringify(result)).toBe(original);
  });

  it("makes blocked/no-op states explicit and never hides blockers", () => {
    const blocked = planned("blocked");
    registerMigrationPreview(blocked, {
      target: "host",
      before: [],
      after: [],
      blockers: Array.from({ length: 20 }, (_, i) => `Missing plugin ${i}`),
    });
    const output = renderMigrationPreview(blocked);
    expect(output).toContain("Blocked: this migration cannot run yet");
    expect(output).toContain("Missing plugin 19");
    expect(output).not.toContain("Would change");
    const noop = planned("noop");
    registerMigrationPreview(noop, { target: "host", before: [], after: [] });
    expect(renderMigrationPreview(noop)).toContain("Already up to date. No changes needed.");
  });

  it("bounds default detail, preserves complete verbose output, and escapes terminal controls", () => {
    const result = planned();
    registerMigrationPreview(result, {
      target: "host\u001b[2J",
      before: [],
      after: [],
      settings: Array.from({ length: 30 }, (_, i) => `Setting ${i}`),
    });
    const normal = renderMigrationPreview(result);
    expect(normal).toContain("6 more; use --verbose");
    expect(normal).not.toContain("Setting 29");
    expect(normal).not.toContain("\u001b");
    expect(renderMigrationPreview(result, { verbose: true })).toContain("Setting 29");
  });
});
