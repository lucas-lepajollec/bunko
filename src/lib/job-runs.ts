import { statement } from './db';

/** The last run of each background job of this instance (when, how long, whether it failed). */
export interface JobRun {
  at: string;
  ms: number;
  failed: boolean;
}
/** Kept in worker_state, which no version trigger watches: recording a run invalidates nothing. */
export function recordJobRun(job: string, startedAt: number, failed: boolean) {
  statement(
    'INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(
    `job_last:${job}`,
    JSON.stringify({
      at: new Date().toISOString(),
      ms: Math.round(Date.now() - startedAt),
      failed,
    } satisfies JobRun),
  );
}
export function lastJobRun(job: string): JobRun | null {
  const row = statement('SELECT value FROM worker_state WHERE key=?').get(`job_last:${job}`) as
    { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as JobRun) : null;
  } catch {
    return null;
  }
}
/** Run a job and record its outcome (failures are recorded and rethrown). */
export async function recorded<T>(job: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let failed = false;
  try {
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      recordJobRun(job, started, failed);
    } catch {
      /* A closed or deleted instance cannot record; the job itself already ended. */
    }
  }
}
