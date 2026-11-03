/**
 * What background work costs, measured where it runs: CPU time and duration of each job, the
 * last runs kept in memory (GET /api/admin/jobs), and a log line for heavy runs and for every
 * 10 s window where the process is busy, naming the jobs running then. Aggregates only: no
 * titles, ids, URLs or settings are recorded.
 */
interface Run {
  job: string;
  tenant: number | null;
  cpuMs: number;
  wallMs: number;
  at: string;
  failed: boolean;
}
interface State {
  runs: Run[];
  active: Map<number, string>;
  next: number;
  sampler: boolean;
}
const scope = globalThis as typeof globalThis & { __bunkoJobStats?: State };
const state: State = (scope.__bunkoJobStats ??= {
  runs: [],
  active: new Map(),
  next: 1,
  sampler: false,
});

const HEAVY_CPU_MS = 2000;
const KEEP = 200;

export async function measured<T>(job: string, tenant: number | null, run: () => Promise<T>) {
  startSampler();
  const key = state.next++;
  state.active.set(key, tenant === null ? job : `${job}#${tenant}`);
  const cpu = process.cpuUsage();
  const started = performance.now();
  let failed = false;
  try {
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    state.active.delete(key);
    const used = process.cpuUsage(cpu);
    const entry: Run = {
      job,
      tenant,
      // Process-wide CPU over the job's lifetime: concurrent work is included.
      cpuMs: Math.round((used.user + used.system) / 1000),
      wallMs: Math.round(performance.now() - started),
      at: new Date().toISOString(),
      failed,
    };
    state.runs.push(entry);
    if (state.runs.length > KEEP) state.runs.splice(0, state.runs.length - KEEP);
    if (entry.cpuMs >= HEAVY_CPU_MS)
      console.log(
        `[bunko] job ${job}${tenant === null ? '' : ` (account ${tenant})`}: ${entry.cpuMs} ms CPU over ${entry.wallMs} ms`,
      );
  }
}

function startSampler() {
  if (state.sampler || process.env.VITEST) return;
  state.sampler = true;
  let last = process.cpuUsage();
  const timer = setInterval(() => {
    const used = process.cpuUsage(last);
    last = process.cpuUsage();
    const percent = Math.round(((used.user + used.system) / 1000 / 10_000) * 100);
    if (percent >= 50)
      console.log(
        `[bunko] busy: ${percent}% CPU over 10 s; running: ${[...state.active.values()].join(', ') || 'requests only'}`,
      );
  }, 10_000);
  timer.unref();
}

/** A request in flight, named by its route (so a busy window can blame a page, not a job). */
export function trackRequest(path: string) {
  const key = state.next++;
  state.active.set(key, `request ${path.replace(/\/[0-9a-z:%-]{16,}/gi, '/…')}`);
  return () => state.active.delete(key);
}
/** Recent runs and per-job totals, heaviest first. */
export function jobStats() {
  const totals = new Map<string, { runs: number; cpuMs: number; maxCpuMs: number }>();
  for (const r of state.runs) {
    const t = totals.get(r.job) ?? { runs: 0, cpuMs: 0, maxCpuMs: 0 };
    t.runs++;
    t.cpuMs += r.cpuMs;
    t.maxCpuMs = Math.max(t.maxCpuMs, r.cpuMs);
    totals.set(r.job, t);
  }
  return {
    running: [...state.active.values()],
    totals: [...totals].map(([job, t]) => ({ job, ...t })).sort((a, b) => b.cpuMs - a.cpuMs),
    recent: state.runs.slice(-50).reverse(),
  };
}
