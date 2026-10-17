import { tenantId } from './tenant-context';
import { dataDir, db } from './db';
import { refreshLibraryProgress } from './kavita';
const scope = globalThis as typeof globalThis & {
  __bunkoProgressRefreshes?: Map<string, Promise<void>>;
};
const runs = (scope.__bunkoProgressRefreshes ??= new Map());
/** All route bundles share the run; SQLite also shares the two-minute attempt budget. */
export async function refreshProgressOnDemand() {
  const userId = tenantId();
  const scopeKey = `${dataDir()}:${userId}`;
  const attemptKey = `progress_refresh_attempt:${userId}`;
  const running = runs.get(scopeKey);
  if (running) return running;
  const now = Date.now();
  const claimed = db()
    .prepare(
      `INSERT INTO worker_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(worker_state.value AS INTEGER)<=?`,
    )
    .run(attemptKey, String(now), now - 120_000).changes;
  if (!claimed) return;
  const run = Promise.resolve()
    .then(() => refreshLibraryProgress(AbortSignal.timeout(15_000)))
    .catch(() => {
      /* The saved reading progress remains available. */
    })
    .finally(() => runs.delete(scopeKey));
  runs.set(scopeKey, run);
  return run;
}
