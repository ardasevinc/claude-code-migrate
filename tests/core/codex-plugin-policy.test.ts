import { describe, expect, it } from "vitest";
import {
  applyCodexPluginPolicies,
  codexPluginPolicyCommandNames,
  evaluateCodexPluginPolicy,
  mergeCodexPluginPolicies,
  type HostCapabilities,
} from "../../src/core/codex-plugin-policy.ts";

const linuxServer: HostCapabilities = {
  os: "linux",
  arch: "x86_64",
  gui: false,
  commands: [],
};

const macWithXcode: HostCapabilities = {
  os: "darwin",
  arch: "arm64",
  gui: true,
  commands: ["xcodebuild"],
};

describe("codex plugin policy", () => {
  it("disables built-in iOS plugin policy on Linux without Xcode", () => {
    const policy = mergeCodexPluginPolicies()["build-ios-apps@openai-curated"];
    expect(policy).toBeDefined();

    const decision = evaluateCodexPluginPolicy(
      "build-ios-apps@openai-curated",
      policy ?? { mode: "auto" },
      linuxServer,
    );

    expect(decision.enabled).toBe(false);
    expect(decision.action).toBe("disable");
    expect(decision.reason).toContain("host os linux");
  });

  it("enables built-in iOS plugin policy on macOS with Xcode", () => {
    const policy = mergeCodexPluginPolicies()["build-ios-apps@openai-curated"];
    expect(policy).toBeDefined();

    const decision = evaluateCodexPluginPolicy(
      "build-ios-apps@openai-curated",
      policy ?? { mode: "auto" },
      macWithXcode,
    );

    expect(decision.enabled).toBe(true);
    expect(decision.action).toBe("enable");
  });

  it("keeps unknown enabled plugins portable by default", () => {
    const result = applyCodexPluginPolicies(
      `
[plugins."codex-security@openai-curated"]
enabled = true
`,
      linuxServer,
    );

    expect(result.content).toContain("enabled = true");
    expect(result.changes).toEqual([]);
  });

  it("rewrites enabled values for plugins that do not match host policy", () => {
    const result = applyCodexPluginPolicies(
      `
[plugins."build-ios-apps@openai-curated"]
enabled = true

[plugins."build-web-apps@openai-curated"]
enabled = true
`,
      linuxServer,
    );

    expect(result.content).toContain(`[plugins."build-ios-apps@openai-curated"]\nenabled = false`);
    expect(result.content).toContain(`[plugins."build-web-apps@openai-curated"]\nenabled = true`);
    expect(result.changes).toHaveLength(1);
  });

  it("allows user policy overrides", () => {
    const result = applyCodexPluginPolicies(
      `
[plugins."build-ios-apps@openai-curated"]
enabled = true
`,
      linuxServer,
      {
        "build-ios-apps@openai-curated": { mode: "always" },
      },
    );

    expect(result.content).toContain("enabled = true");
    expect(result.changes).toEqual([]);
  });

  it("preserves target plugin enabled values when requested", () => {
    const result = applyCodexPluginPolicies(
      `
[plugins."computer-use@openai-bundled"]
enabled = true
`,
      linuxServer,
      {
        "computer-use@openai-bundled": { mode: "preserve" },
      },
      {
        preserveConfigRaw: `
[plugins."computer-use@openai-bundled"]
enabled = false
`,
      },
    );

    expect(result.content).toContain("enabled = false");
    expect(result.changes).toEqual([
      "computer-use@openai-bundled: preserved target enabled = false",
    ]);
  });

  it("restores preserved target plugin entries that are missing from incoming config", () => {
    const result = applyCodexPluginPolicies(
      `
[plugins."build-web-apps@openai-curated"]
enabled = true
`,
      linuxServer,
      {
        "computer-use@openai-bundled": { mode: "preserve" },
      },
      {
        preserveConfigRaw: `
[plugins."computer-use@openai-bundled"]
enabled = false
`,
      },
    );

    expect(result.content).toContain(`[plugins."computer-use@openai-bundled"]\nenabled = false`);
    expect(result.changes).toContain(
      "computer-use@openai-bundled: preserved target enabled = false",
    );
  });

  it("collects command probes from merged policies", () => {
    expect(codexPluginPolicyCommandNames(mergeCodexPluginPolicies())).toEqual([
      "adb",
      "xcodebuild",
    ]);
  });
});
