import { describe, expect, it, vi } from "vitest";
import { createSshSession } from "../../src/core/ssh-session.ts";

describe("SSH session setup", () => {
  it("removes a partially-created control directory when setup fails", async () => {
    const removed = vi.fn(async () => undefined);
    await expect(
      createSshSession("operator@example.test", {
        mkdtemp: async () => "/tmp/ccm-ssh-partial",
        chmod: async () => {
          throw new Error("chmod failed");
        },
        rm: removed,
      }),
    ).rejects.toThrow("chmod failed");

    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("/tmp/ccm-ssh-partial", {
      recursive: true,
      force: true,
    });
  });

  it("composes setup and cleanup failures", async () => {
    await expect(
      createSshSession("operator@example.test", {
        mkdtemp: async () => "/tmp/ccm-ssh-partial",
        chmod: async () => {
          throw new Error("chmod failed");
        },
        rm: async () => {
          throw new Error("rm failed");
        },
      }),
    ).rejects.toThrow("SSH session setup failed and temporary state could not be removed");
  });
});
