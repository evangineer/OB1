import type { PersistResult } from "./idb-persistence.js";

export type ShutdownResult = { outcome: "done" | "timeout" | "save-failed"; exitCode: 0 | 1 };

/** Runs the shutdown steps, bounded by `timeoutMs`. A rejected `steps()` counts as save-failed. */
export async function runShutdown(
  steps: () => Promise<PersistResult | void>,
  timeoutMs: number,
): Promise<ShutdownResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ShutdownResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout", exitCode: 1 }), timeoutMs);
  });
  const work = (async (): Promise<ShutdownResult> => {
    try {
      const r = await steps();
      if (r && r.ok === false) return { outcome: "save-failed", exitCode: 1 };
      return { outcome: "done", exitCode: 0 };
    } catch {
      return { outcome: "save-failed", exitCode: 1 };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
