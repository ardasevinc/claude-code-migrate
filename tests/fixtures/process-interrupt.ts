import { runProcess } from "../../src/utils/process.ts";

const marker = process.argv[2];
if (!marker) throw new Error("marker path is required");

const child = runProcess(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 1000)",
  marker,
]);
process.stdout.write("ready\n");
await child;
