import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyResolvedCodexProfile,
  applyPushProfile,
  verifyPushProfileAssets,
} from "../../src/core/push-profile.ts";

describe("push profiles", () => {
  it("builds a copied logical view with instruction and structured config effects", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-push-profile-")));
    const profileDir = join(root, "profiles/devbox");
    await mkdir(profileDir, { recursive: true });
    const sourceConfig = join(root, "source-config.toml");
    const sourceSettings = join(root, "source-settings.json");
    await Promise.all([
      writeFile(join(profileDir, "AGENTS.md"), "remote instructions\n"),
      writeFile(sourceConfig, 'model = "source"\n[features]\nexperimental = true\n'),
      writeFile(sourceSettings, '{"env":{"LOCAL_ONLY":"yes","KEEP":"ok"}}\n'),
    ]);
    const inputFiles = [
      {
        sourcePath: sourceConfig,
        relativePath: "codex/config.toml",
        isSymlink: false,
      },
      {
        sourcePath: sourceSettings,
        relativePath: "claude/settings.json",
        isSymlink: false,
      },
    ];

    const applied = await applyPushProfile({
      name: "devbox",
      configDir: root,
      providers: ["claude", "codex"],
      files: inputFiles,
      definition: {
        host: "operator@devbox",
        agents_md: "profiles/devbox/AGENTS.md",
        claude: {
          settings: {
            unset: ["/env/LOCAL_ONLY"],
            set: { env: { DEPLOY_ENV: "devbox" } },
          },
        },
        codex: {
          config: {
            unset: ["/model", "/features/experimental"],
            set: { model_reasoning_effort: "high" },
          },
          plugin_policies: { "demo@market": { mode: "always" } },
        },
      },
    });

    const content = (path: string) =>
      applied.files.find((file) => file.relativePath === path)?.mcpServersOnly;
    expect(content("codex/AGENTS.md")).toBe("remote instructions\n");
    expect(content("claude/settings.json")).toBe(
      '{\n  "env": {\n    "KEEP": "ok",\n    "DEPLOY_ENV": "devbox"\n  }\n}\n',
    );
    const finalCodex = Buffer.from(
      applyResolvedCodexProfile(Buffer.from(await readFile(sourceConfig)), applied.profile) ?? [],
    ).toString("utf8");
    expect(finalCodex).toContain('model_reasoning_effort = "high"');
    expect(finalCodex).not.toContain("experimental");
    expect(applied.profile.pluginPolicies).toEqual({ "demo@market": { mode: "always" } });
    expect(applied.profile.effectCodes.get("codex/AGENTS.md")).toBe(
      "profile.devbox.codex-instructions",
    );
    expect(await readFile(sourceConfig, "utf8")).toContain('model = "source"');
    expect(await readFile(sourceSettings, "utf8")).toContain("LOCAL_ONLY");
  });

  it("rejects profile asset drift before execution", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-push-profile-drift-")));
    await writeFile(join(root, "AGENTS.md"), "planned\n");
    const applied = await applyPushProfile({
      name: "devbox",
      configDir: root,
      providers: ["codex"],
      files: [],
      definition: {
        host: "operator@devbox",
        agents_md: "AGENTS.md",
      },
    });
    await writeFile(join(root, "AGENTS.md"), "changed\n");
    await expect(verifyPushProfileAssets(applied.profile)).rejects.toThrow(
      "Profile assets changed after planning",
    );
  });

  it("does not load assets belonging only to an unselected provider", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-push-profile-selected-")));
    const applied = await applyPushProfile({
      name: "devbox",
      configDir: root,
      providers: ["codex"],
      files: [],
      definition: {
        host: "operator@devbox",
        claude_md: "missing/CLAUDE.md",
        codex: { config: { set: { model: "gpt-5.6" } } },
      },
    });
    expect(applied.profile.assets).toEqual([]);
    expect(applied.files.some((file) => file.relativePath === "codex/config.toml")).toBe(true);
  });

  it("rejects forged forbidden Codex patches outside the config loader", () => {
    expect(() =>
      applyResolvedCodexProfile(Buffer.from(""), {
        name: "devbox",
        host: "operator@devbox",
        configDir: "/trusted",
        definition: {
          host: "operator@devbox",
          codex: { config: { set: { mcp_servers: { evil: { command: "x" } } } } },
        },
        assets: [],
        effectCodes: new Map(),
        warnings: [],
        pluginPolicies: {},
      }),
    ).toThrow("forbidden Codex subtree /mcp_servers");
  });
});
