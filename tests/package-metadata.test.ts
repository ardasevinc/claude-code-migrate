import { describe, expect, test } from "vitest";
import packageMetadata from "../package.json";

describe("package runtime contract", () => {
  test("pins the contributor runtime and declares the consumer floor", () => {
    expect(packageMetadata.packageManager).toBe("bun@1.3.14");
    expect(packageMetadata.engines).toEqual({ bun: ">=1.3.14" });
    expect(packageMetadata.os).toEqual(["darwin", "linux"]);
  });

  test("publishes the Bun CLI and release-facing files", () => {
    expect(packageMetadata.bin).toEqual({ ccm: "./src/index.ts" });
    expect(packageMetadata.files).toEqual(["src/", "LICENSE", "README.md", "CHANGELOG.md"]);
    expect(packageMetadata.repository.url).toBe(
      "git+https://github.com/ardasevinc/claude-code-migrate.git",
    );
  });
});
