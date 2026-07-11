import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/utils/logger.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger streams", () => {
  it.each([
    ["info", "info message"],
    ["success", "success message"],
    ["dim", "dim message"],
    ["file", "path/to/file"],
  ] as const)("writes %s messages to stdout", (method, message) => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderrWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderrError = vi.spyOn(console, "error").mockImplementation(() => {});

    log[method](message);

    expect(stdout).toHaveBeenCalledOnce();
    expect(stderrWarn).not.toHaveBeenCalled();
    expect(stderrError).not.toHaveBeenCalled();
  });

  it("writes warnings to stderr", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "warn").mockImplementation(() => {});

    log.warn("warning message");

    expect(stderr).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes errors to stderr", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    log.error("error message");

    expect(stderr).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });
});
