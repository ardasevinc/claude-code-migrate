const cleanups = new Map<symbol, () => Promise<void>>();
let handlersInstalled = false;
let handlingSignal = false;

export function registerInterruptCleanup(cleanup: () => Promise<void>): () => void {
  installSignalHandlers();
  const key = Symbol("interrupt-cleanup");
  cleanups.set(key, cleanup);
  return () => cleanups.delete(key);
}

export async function cleanupInterruptResources(): Promise<void> {
  const pending = [...cleanups.values()].reverse();
  cleanups.clear();
  for (const cleanup of pending) await Promise.allSettled([cleanup()]);
}

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.once("SIGINT", () => void handleSignal(130));
  process.once("SIGTERM", () => void handleSignal(143));
}

async function handleSignal(exitCode: number): Promise<void> {
  if (handlingSignal) return;
  handlingSignal = true;
  await cleanupInterruptResources();
  process.exit(exitCode);
}
