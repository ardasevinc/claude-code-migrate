import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/utils/process.ts";

const helper = fileURLToPath(new URL("../../src/core/remote-push-helper.py", import.meta.url));
const probe = `
import os,sys,types
p=sys.argv[1]
scope={"__name__":"probe","__file__":p}
exec(compile(open(p).read(),p,"exec"),scope)
uid=os.geteuid()
gid=os.stat(sys.argv[2]).st_gid
case=sys.argv[3]
owner=types.SimpleNamespace(pw_uid=uid,pw_gid=gid)
other=types.SimpleNamespace(pw_uid=uid+1,pw_gid=gid)
if case != "system":
    scope["pwd"].getpwall=lambda: [] if case == "empty" else [owner,other] if case == "primary" else [owner]
    scope["pwd"].getpwnam=lambda name: other if name == "other" else owner
    scope["grp"].getgrgid=lambda value: types.SimpleNamespace(gr_mem=["other"] if case == "explicit" else [])
    if case == "unknown":
        def missing(value): raise KeyError(value)
        scope["grp"].getgrgid=missing
try:
    fd=scope["open_executable"](sys.argv[2])
    os.close(fd)
    if case == "private":
        try:
            scope["open_absolute_directory"](os.path.dirname(sys.argv[2]),"workspace",private=True)
            raise AssertionError("workspace privacy was relaxed")
        except scope["Blocked"]: pass
    print("accepted")
except scope["Blocked"] as error:
    print(str(error))
    sys.exit(64)
`;

describe("Codex executable permissions", () => {
  it.each([
    ["private", 0o775, 0o775, true],
    ["primary", 0o775, 0o755, false],
    ["explicit", 0o775, 0o755, false],
    ["empty", 0o775, 0o755, false],
    ["unknown", 0o775, 0o755, false],
    ["private", 0o777, 0o755, false],
    ["private", 0o755, 0o777, false],
    ["primary", 0o755, 0o775, false],
  ] as const)("checks %s membership with directory %i and executable %i", async (membership, directoryMode, fileMode, accepted) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccm-command-permissions-")));
    try {
      const command = join(root, "codex");
      await writeFile(command, "#!/bin/sh\nexit 0\n");
      await chmod(command, fileMode);
      await chmod(root, directoryMode);
      const result = await runProcess("python3", ["-B", "-c", probe, helper, command, membership], {
        nothrow: true,
      });
      expect(result.exitCode, result.stderr || result.stdout).toBe(accepted ? 0 : 64);
      if (!accepted) expect(result.stdout).toContain("unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a resolved executable in a root-owned system directory", async () => {
    const command = await realpath("/bin/sh");
    const result = await runProcess("python3", ["-B", "-c", probe, helper, command, "system"]);
    expect(result.stdout).toBe("accepted\n");
  });
});
