import { dataDir, db } from './db';
import { refreshLibraryProgress } from './kavita';
const scope = globalThis as typeof globalThis & {
  __bunkoProgressRefreshes?: Map<string, Promise<void>>;
};
const runs = (scope.__bunkoProgressRefreshes ??= new Map());
/** All route bundles share the run; SQLite also shares the two-minute attempt budget. */
export async function refreshProgressOnDemand() {
  const running = runs.get(dataDir);
  if (running) return running;
  const now = Date.now();
  const claimed = db()
    .prepare(
      `INSERT INTO worker_state(key,value) VALUES('progress_refresh_attempt',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(worker_state.value AS INTEGER)<=?`,
    )
    .run(String(now), now - 120_000).changes;
  if (!claimed) return;
  const run = Promise.resolve()
    .then(() => refreshLibraryProgress(AbortSignal.timeout(15_000)))
    .catch(() => {
      /* The saved reading progress remains available. */
    })
    .finally(() => runs.delete(dataDir));
  runs.set(dataDir, run);
  return run;
}
