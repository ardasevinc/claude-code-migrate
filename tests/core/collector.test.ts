import { mkdir, mkdtemp, rm, symlink, writeFile as writeFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "../../src/core/collector.ts";

let rootDir = "";

async function writeFixtureFile(path: string, content: string): Promise<void> {
  await writeFileFs(path, content, "utf8");
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "ccm-collector-test-"));

  const claudeDir = join(rootDir, ".claude");
  const codexDir = join(rootDir, ".codex");
  const sharedSkillsDir = join(rootDir, ".agents", "skills");
  const sharedLazySkillsDir = join(rootDir, ".agents", "lazy-skills");

  await mkdir(join(claudeDir, "agents"), { recursive: true });
  await mkdir(join(claudeDir, "skills", "native"), { recursive: true });
  await mkdir(join(codexDir, "agents"), { recursive: true });
  await mkdir(join(codexDir, "rules"), { recursive: true });
  await mkdir(join(codexDir, "skills"), { recursive: true });
  await mkdir(join(codexDir, "skills", ".system", "openai-docs"), { recursive: true });
  await mkdir(join(sharedSkillsDir, "shared-skill"), { recursive: true });
  await mkdir(join(sharedLazySkillsDir, "lazy-pack"), { recursive: true });

  await writeFixtureFile(join(claudeDir, "CLAUDE.md"), "claude");
  await writeFixtureFile(join(claudeDir, "settings.json"), "{}");
  await writeFixtureFile(join(claudeDir, "agents", "planner.md"), "planner");
  await writeFixtureFile(join(claudeDir, "skills", "native", "SKILL.md"), "native");
  await writeFixtureFile(join(claudeDir, "statusline.sh"), "#!/bin/sh\necho ok\n");
  await writeFixtureFile(join(claudeDir, "settings.local.json"), "{}");

  await symlink(join(sharedSkillsDir, "shared-skill"), join(claudeDir, "skills", "shared-skill"));

  await writeFixtureFile(
    join(rootDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        localTool: {
          command: "~/tools/mcp-server",
        },
      },
    }),
  );

  await writeFixtureFile(
    join(codexDir, "config.toml"),
    `
[mcp_servers.local]
command = "./scripts/run-mcp"
`,
  );
  await writeFixtureFile(join(codexDir, "AGENTS.md"), "codex");
  await writeFixtureFile(join(codexDir, "hooks.json"), '{"hooks":{}}');
  await writeFixtureFile(join(codexDir, "agents", "reviewer.md"), "reviewer");
  await writeFixtureFile(join(codexDir, "rules", "general.md"), "rules");
  await writeFixtureFile(join(codexDir, "skills", "codex-skill.md"), "skill");
  await writeFixtureFile(join(codexDir, "skills", ".system", "openai-docs", "SKILL.md"), "system");

  await writeFixtureFile(join(sharedSkillsDir, "shared-skill", "SKILL.md"), "shared");
  await writeFixtureFile(join(sharedLazySkillsDir, "lazy-pack", "SKILL.md"), "lazy");
  await writeFixtureFile(join(rootDir, ".agents", ".skill-lock.json"), "{}\n");
});

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe("collector multi-provider", () => {
  it("collects claude + shared and excludes claude symlinked shared skills", async () => {
    const files = await collectFiles({
      providers: ["claude"],
      includeClaudeSettingsLocal: true,
      includeClaudeMcpConfig: true,
      paths: {
        claudeDir: join(rootDir, ".claude"),
        codexDir: join(rootDir, ".codex"),
        claudeMcpConfigPath: join(rootDir, ".claude.json"),
        sharedAgentsDir: join(rootDir, ".agents"),
        sharedSkillsDir: join(rootDir, ".agents", "skills"),
        sharedLazySkillsDir: join(rootDir, ".agents", "lazy-skills"),
        sharedSkillLockPath: join(rootDir, ".agents", ".skill-lock.json"),
      },
    });

    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain("claude/CLAUDE.md");
    expect(paths).toContain("claude/skills/native/SKILL.md");
    expect(paths).toContain("claude/.mcp-config.json");

    expect(paths).toContain("shared/agents/skills/shared-skill/SKILL.md");
    expect(paths).toContain("shared/agents/lazy-skills/lazy-pack/SKILL.md");
    expect(paths).toContain("shared/agents/.skill-lock.json");

    expect(paths).not.toContain("claude/skills/shared-skill/SKILL.md");
  });

  it("collects codex + shared layout", async () => {
    const files = await collectFiles({
      providers: ["codex"],
      includeClaudeSettingsLocal: false,
      includeClaudeMcpConfig: false,
      paths: {
        claudeDir: join(rootDir, ".claude"),
        codexDir: join(rootDir, ".codex"),
        claudeMcpConfigPath: join(rootDir, ".claude.json"),
        sharedAgentsDir: join(rootDir, ".agents"),
        sharedSkillsDir: join(rootDir, ".agents", "skills"),
        sharedLazySkillsDir: join(rootDir, ".agents", "lazy-skills"),
        sharedSkillLockPath: join(rootDir, ".agents", ".skill-lock.json"),
      },
    });

    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain("codex/config.toml");
    expect(paths).toContain("codex/AGENTS.md");
    expect(paths).toContain("codex/hooks.json");
    expect(paths).toContain("codex/skills/codex-skill.md");
    expect(paths).not.toContain("codex/skills/.system/openai-docs/SKILL.md");
    expect(paths).toContain("shared/agents/skills/shared-skill/SKILL.md");
    expect(paths).toContain("shared/agents/lazy-skills/lazy-pack/SKILL.md");
    expect(paths).toContain("shared/agents/.skill-lock.json");
    expect(paths.some((path) => path.startsWith("claude/"))).toBe(false);
  });

  it("does not collect codex symlinks that resolve to excluded or outside paths", async () => {
    const codexDir = join(rootDir, ".codex");
    const outsideSecretPath = join(rootDir, "outside-secret.txt");

    await writeFixtureFile(join(codexDir, "auth.json"), '{"token":"secret"}');
    await writeFixtureFile(outsideSecretPath, "secret");
    await symlink(join(codexDir, "auth.json"), join(codexDir, "skills", "auth-link.json"));
    await symlink(outsideSecretPath, join(codexDir, "skills", "outside-link.txt"));

    const files = await collectFiles({
      providers: ["codex"],
      includeClaudeSettingsLocal: false,
      includeClaudeMcpConfig: false,
      paths: {
        claudeDir: join(rootDir, ".claude"),
        codexDir,
        claudeMcpConfigPath: join(rootDir, ".claude.json"),
        sharedAgentsDir: join(rootDir, ".agents"),
        sharedSkillsDir: join(rootDir, ".agents", "skills"),
        sharedLazySkillsDir: join(rootDir, ".agents", "lazy-skills"),
        sharedSkillLockPath: join(rootDir, ".agents", ".skill-lock.json"),
      },
    });

    const paths = files.map((file) => file.relativePath);

    expect(paths).not.toContain("codex/skills/auth-link.json");
    expect(paths).not.toContain("codex/skills/outside-link.txt");
  });

  it("collects configured codex local marketplace sources under ccm archive paths", async () => {
    const codexDir = join(rootDir, ".codex");
    const marketplaceDir = join(rootDir, "marketplaces", "openai-bundled");

    await mkdir(join(marketplaceDir, ".agents", "plugins"), { recursive: true });
    await mkdir(join(marketplaceDir, "plugins", "browser", ".codex-plugin"), { recursive: true });
    await writeFixtureFile(
      join(marketplaceDir, ".agents", "plugins", "marketplace.json"),
      '{"plugins":[]}',
    );
    await writeFixtureFile(
      join(marketplaceDir, "plugins", "browser", ".codex-plugin", "plugin.json"),
      "{}",
    );
    await writeFixtureFile(
      join(codexDir, "config.toml"),
      `
[marketplaces.openai-bundled]
source_type = "local"
source = "${marketplaceDir}"
`,
    );

    const files = await collectFiles({
      providers: ["codex"],
      includeClaudeSettingsLocal: false,
      includeClaudeMcpConfig: false,
      paths: {
        claudeDir: join(rootDir, ".claude"),
        codexDir,
        claudeMcpConfigPath: join(rootDir, ".claude.json"),
        sharedAgentsDir: join(rootDir, ".agents"),
        sharedSkillsDir: join(rootDir, ".agents", "skills"),
        sharedLazySkillsDir: join(rootDir, ".agents", "lazy-skills"),
        sharedSkillLockPath: join(rootDir, ".agents", ".skill-lock.json"),
      },
    });

    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain(
      "codex/.ccm/marketplaces/openai-bundled/.agents/plugins/marketplace.json",
    );
    expect(paths).toContain(
      "codex/.ccm/marketplaces/openai-bundled/plugins/browser/.codex-plugin/plugin.json",
    );
  });

  it("collects claude, codex, and shared once for multi-provider pushes", async () => {
    const files = await collectFiles({
      providers: ["claude", "codex"],
      includeClaudeSettingsLocal: false,
      includeClaudeMcpConfig: true,
      paths: {
        claudeDir: join(rootDir, ".claude"),
        codexDir: join(rootDir, ".codex"),
        claudeMcpConfigPath: join(rootDir, ".claude.json"),
        sharedAgentsDir: join(rootDir, ".agents"),
        sharedSkillsDir: join(rootDir, ".agents", "skills"),
        sharedLazySkillsDir: join(rootDir, ".agents", "lazy-skills"),
        sharedSkillLockPath: join(rootDir, ".agents", ".skill-lock.json"),
      },
    });

    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain("claude/CLAUDE.md");
    expect(paths).toContain("codex/AGENTS.md");
    expect(paths).toContain("shared/agents/skills/shared-skill/SKILL.md");
    expect(
      paths.filter((path) => path === "shared/agents/lazy-skills/lazy-pack/SKILL.md"),
    ).toHaveLength(1);
    expect(paths.filter((path) => path === "shared/agents/.skill-lock.json")).toHaveLength(1);
  });
});
