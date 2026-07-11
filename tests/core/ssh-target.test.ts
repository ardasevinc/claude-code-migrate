import { describe, expect, it } from "vitest";
import { isValidSshTarget, parseSshTarget } from "../../src/core/ssh-target.ts";

describe("ssh-target", () => {
  it.each([
    ["prod", { raw: "prod", host: "prod" }],
    ["prod-web_1", { raw: "prod-web_1", host: "prod-web_1" }],
    ["example.com", { raw: "example.com", host: "example.com" }],
    ["deploy@example.com", { raw: "deploy@example.com", user: "deploy", host: "example.com" }],
    ["192.168.1.10", { raw: "192.168.1.10", host: "192.168.1.10" }],
    ["root@127.0.0.1", { raw: "root@127.0.0.1", user: "root", host: "127.0.0.1" }],
    ["123", { raw: "123", host: "123" }],
    ["1.2.3", { raw: "1.2.3", host: "1.2.3" }],
  ])("parses %s", (raw, expected) => {
    expect(parseSshTarget(raw)).toEqual(expected);
    expect(isValidSshTarget(raw)).toBe(true);
  });

  it.each([
    "",
    "-prod",
    "user@-prod",
    "@host",
    "user@",
    "user@@host",
    "user name@host",
    "host\ncommand",
    "host/path",
    "host\\path",
    "host:22",
    "::1",
    "[::1]",
    "user@host:22",
    "host;command",
    "host&&command",
    "host|command",
    "host$(command)",
    "host`command`",
  ])("rejects %j", (raw) => {
    expect(() => parseSshTarget(raw)).toThrow("Invalid SSH target");
    expect(isValidSshTarget(raw)).toBe(false);
  });

  it("escapes rejected control characters in errors", () => {
    expect(() => parseSshTarget("host\nforged")).toThrow('Invalid SSH target "host\\nforged"');
  });
});
