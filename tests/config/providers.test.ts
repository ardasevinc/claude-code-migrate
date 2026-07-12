import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectionPathsForHome } from "../../src/config/providers.ts";

describe("collectionPathsForHome", () => {
  it("derives independent collection paths for each runtime home", () => {
    const first = collectionPathsForHome("/synthetic/first");
    const second = collectionPathsForHome("/synthetic/second");

    expect(first.claudeDir).toBe(join("/synthetic/first", ".claude"));
    expect(first.sharedSkillsDir).toBe(join("/synthetic/first", ".agents", "skills"));
    expect(second.codexDir).toBe(join("/synthetic/second", ".codex"));
    expect(second.sharedSkillsDir).toBe(join("/synthetic/second", ".agents", "skills"));
    expect(first).not.toEqual(second);
  });
});
