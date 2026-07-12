import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeLocalTransaction } from "../../src/core/local-transaction.ts";
import { createRuntimeContext } from "../../src/runtime/context.ts";

const root = process.argv[2];
const boundary = process.argv[3];
if (!root || !boundary) process.exit(2);
const home = join(root, "home");
const codex = join(home, ".codex");
await mkdir(codex, { recursive: true, mode: 0o700 });
await writeFile(join(codex, "AGENTS.md"), "old\n");
const context = createRuntimeContext({
  home,
  process: { cwd: () => home, env: { XDG_STATE_HOME: join(root, "state") } },
});

await executeLocalTransaction({
  context,
  planId: "plan_interrupt_fixture",
  roots: [{ code: "codex-home", path: codex }],
  members: [
    {
      id: "codex-agents",
      rootCode: "codex-home",
      targetRef: "AGENTS.md",
      materialize: (stage) => writeFile(stage, "new\n"),
    },
  ],
  verify: async () => {},
  afterBoundary: async (observed) => {
    if (observed !== boundary) return;
    process.stdout.write("ready\n");
    await new Promise(() => {});
  },
});
