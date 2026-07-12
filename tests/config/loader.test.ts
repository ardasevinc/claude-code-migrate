import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigDir, isSafeProfileName, loadConfig } from "../../src/config/loader.ts";

async function configFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccm-profile-config-"));
  const path = join(dir, "nested", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("profile config", () => {
  it("normalizes a fully structured profile and exposes its config directory", async () => {
    const path = await configFile(`
[profiles.devbox]
host = "arda@devbox"
claude_md = "profiles/devbox/CLAUDE.md"
agents_md = "profiles/devbox/AGENTS.md"

[profiles.devbox.claude.settings]
unset = ["/env/LOCAL_ONLY"]

[profiles.devbox.claude.settings.set]
env = { DEPLOY_ENV = "devbox" }

[profiles.devbox.codex.config]
unset = ["/model", "/features/experimental"]

[profiles.devbox.codex.config.set]
model_reasoning_effort = "high"

[profiles.devbox.codex.plugin_policies."demo@market"]
mode = "never"
os = ["linux"]
commands = ["demo"]
gui = false
`);
    const config = await loadConfig(path);
    expect(getConfigDir(path)).toBe(dirname(path));
    expect(config.profiles.devbox).toEqual({
      host: "arda@devbox",
      claude_md: "profiles/devbox/CLAUDE.md",
      agents_md: "profiles/devbox/AGENTS.md",
      claude: {
        settings: { unset: ["/env/LOCAL_ONLY"], set: { env: { DEPLOY_ENV: "devbox" } } },
      },
      codex: {
        config: {
          unset: ["/model", "/features/experimental"],
          set: { model_reasoning_effort: "high" },
        },
        plugin_policies: {
          "demo@market": {
            mode: "never",
            os: ["linux"],
            commands: ["demo"],
            gui: false,
          },
        },
      },
    });
  });

  it.each([
    ['[profiles."../escape"]\nhost = "user@host"', "safe profile name"],
    ['[profiles.devbox]\nclaude_md = "x"', "host is required"],
    ['[profiles.devbox]\nhost = "x"\nunknown = true', "not a recognized setting"],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.claude.settings]\nremove = []',
      "not a recognized setting",
    ],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.claude.settings]\nunset = [""]',
      "nonempty strings",
    ],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.codex.config]\nunset = [1]',
      "must be an array",
    ],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.codex.config]\nunset = ["/plugins/demo"]',
      "forbidden Codex subtree /plugins",
    ],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.codex.config.set.hooks]\nstate = { demo = true }',
      "forbidden Codex subtree /hooks/state",
    ],
    ['[profiles."constructor"]\nhost = "x"', "safe profile name"],
    [
      '[profiles.devbox]\nhost = "x"\n[profiles.devbox.codex.plugin_policies."__proto__"]\nmode = "never"',
      "plugin ID is forbidden",
    ],
  ])("fails closed for invalid nested profile config", async (content, message) => {
    await expect(loadConfig(await configFile(content))).rejects.toThrow(message);
  });

  it("uses a fresh empty profile map when a custom config path is absent", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ccm-missing-config-")), "config.toml");
    const config = await loadConfig(path);
    expect(config.profiles).toEqual({});
  });

  it.each([
    "devbox",
    "worker_3",
    "linux-b200",
    "vyvo.worker",
  ])("accepts safe profile name %s", (name) => {
    expect(isSafeProfileName(name)).toBe(true);
  });

  it.each([
    "",
    "Devbox",
    "../devbox",
    "devbox-",
    "constructor",
    "a".repeat(65),
  ])("rejects unsafe profile name %s", (name) => expect(isSafeProfileName(name)).toBe(false));
});
