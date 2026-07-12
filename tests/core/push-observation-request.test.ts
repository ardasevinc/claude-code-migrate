import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  preparePushObservationRequest,
  pushObservationRequestIdentity,
} from "../../src/core/push-observation-request.ts";
import type { FileEntry } from "../../src/types/index.ts";

describe("prepared push observation request", () => {
  it("derives canonical roots and queries before observing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-push-request-"));
    const file = async (relativePath: string, content = "x"): Promise<FileEntry> => {
      const sourcePath = join(root, relativePath.replaceAll("/", "-"));
      await writeFile(sourcePath, content);
      return { sourcePath, relativePath, isSymlink: false };
    };
    const request = await preparePushObservationRequest({
      host: "user@example.test",
      providers: ["claude", "codex"],
      files: [
        await file("claude/.mcp-config.json", "{}"),
        await file("claude/settings.json"),
        await file("shared/agents/skills/demo/SKILL.md"),
        await file("codex/config.toml", ""),
      ],
    });

    expect(request.inventoryRoots).toEqual([
      "claude/settings.json",
      "claude/skills",
      "codex/config.toml",
      "shared/agents/skills",
    ]);
    expect(request.queries.sharedSkillNames).toBe(true);
    expect(request.queries.codexPluginList).toBe(true);
    expect(request.queries.commandNames).toContain("codex");
    expect(request.requestIdentity).toBe(
      pushObservationRequestIdentity({
        host: request.host,
        inventoryRoots: [...request.inventoryRoots].reverse(),
        queries: {
          ...request.queries,
          commandNames: [...(request.queries.commandNames ?? [])].reverse(),
        },
      }),
    );
  });

  it("does not request the Claude skills view without both actual roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccm-push-request-"));
    const sourcePath = join(root, "skill");
    await writeFile(sourcePath, "x");
    const request = await preparePushObservationRequest({
      host: "host",
      providers: ["claude"],
      files: [{ sourcePath, relativePath: "shared/agents/skills/demo/SKILL.md", isSymlink: false }],
    });
    expect(request.inventoryRoots).toEqual(["shared/agents/skills"]);
    expect(request.queries.sharedSkillNames).toBe(false);
  });
});
