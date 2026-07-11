import { mkdir, writeFile } from "node:fs/promises";
import { registerInterruptCleanup } from "../../src/utils/interrupt-cleanup.ts";

const path = process.argv[2];
if (!path) process.exit(2);

await mkdir(path, { recursive: true });
await writeFile(`${path}/owned`, "temporary\n", "utf8");
registerInterruptCleanup(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
});

process.stdout.write("ready\n");
await new Promise(() => {});
