import type { ActivityEvent, BackgroundJobId } from '@/types/shared';
import { statement } from './db';
import { tenantState } from './tenant-context';

/** The last run of each background job of this instance (when, how long, whether it failed). */
export interface JobRun {
  at: string;
  ms: number;
  failed: boolean;
}

export interface LiveJobProgress {
  done: number;
  total: number | null;
  detail: string | null;
}

const MAX_EVENTS = 15;
const liveState = tenantState(() => ({
  progress: new Map<string, LiveJobProgress>(),
  events: [] as ActivityEvent[],
  seq: 1,
}));

export function setJobProgress(job: string, progress: LiveJobProgress) {
  try {
    liveState().progress.set(job, progress);
  } catch {
    /* Outside tenant context. */
  }
}

export function clearJobProgress(job: string) {
  try {
    liveState().progress.delete(job);
  } catch {
    /* Outside tenant context. */
  }
}

export function getJobProgress(job: string): LiveJobProgress | null {
  try {
    return liveState().progress.get(job) ?? null;
  } catch {
    return null;
  }
}

export function recentActivityEvents(): ActivityEvent[] {
  try {
    return [...liveState().events];
  } catch {
    return [];
  }
}

function pushEvent(job: string, at: string, ms: number, failed: boolean, detail?: string | null) {
  try {
    const state = liveState();
    const id = `${job}:${state.seq++}`;
    state.events.unshift({
      id,
      job: job as BackgroundJobId,
      at,
      ms,
      failed,
      ...(detail ? { detail } : {}),
    });
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  } catch {
    /* Outside tenant context. */
  }
}

/** Kept in worker_state, which no version trigger watches: recording a run invalidates nothing. */
export function recordJobRun(job: string, startedAt: number, failed: boolean) {
  const at = new Date().toISOString();
  const ms = Math.round(Date.now() - startedAt);
  statement(
    'INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(
    `job_last:${job}`,
    JSON.stringify({
      at,
      ms,
      failed,
    } satisfies JobRun),
  );
  // Keep meaningful runs and all failures in the in-memory activity journal (ignore idle no-op ticks).
  const hadProgress = Boolean(getJobProgress(job));
  if (failed || hadProgress || ms >= 250) pushEvent(job, at, ms, failed);
}

export function lastJobRun(job: string): JobRun | null {
  const row = statement('SELECT value FROM worker_state WHERE key=?').get(`job_last:${job}`) as
    | { value: string }
    | undefined;
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
    clearJobProgress(job);
  }
}
