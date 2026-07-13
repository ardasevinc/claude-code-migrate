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

  it("keeps interrupt cleanup registered until an in-flight close completes", async () => {
    let releaseClose: (() => void) | undefined;
    let interruptCleanup: (() => Promise<void>) | undefined;
    const unregister = vi.fn();
    const removed = vi.fn(async () => undefined);
    const session = await createSshSession("operator@example.test", {
      mkdtemp: async () => "/tmp/ccm-ssh-closing",
      chmod: async () => undefined,
      rm: removed,
      runProcess: async () => {
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      },
      registerCleanup: (cleanup) => {
        interruptCleanup = cleanup;
        return unregister;
      },
    });

    const close = session.close();
    expect(unregister).not.toHaveBeenCalled();
    const interruptedClose = interruptCleanup?.();
    expect(interruptedClose).toBe(close);
    expect(unregister).not.toHaveBeenCalled();

    releaseClose?.();
    await Promise.all([close, interruptedClose]);
    expect(removed).toHaveBeenCalledWith("/tmp/ccm-ssh-closing", {
      recursive: true,
      force: true,
    });
    expect(unregister).toHaveBeenCalledOnce();
  });
});
