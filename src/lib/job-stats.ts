/**
 * What background work costs, measured where it runs: CPU time and duration of each job, the
 * last runs kept in memory (GET /api/admin/jobs), and a log line for heavy runs and for every
 * 10 s window where the process is busy, naming the jobs running then. Aggregates only: no
 * titles, ids, URLs or settings are recorded.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const background = new AsyncLocalStorage<string>();
/** Whether the current code runs inside a background job (not a page or API request). */
export const inBackgroundJob = () => background.getStore() !== undefined;

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
    return await background.run(job, run);
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
        `[bunko] busy: ${percent}% CPU over 10 s; running: ${[...state.active.values()].join(', ') || 'no background job'}`,
      );
    if (percent >= 80) void profileBusyWindow();
  }, 10_000);
  timer.unref();
}

/**
 * When the process stays busy, sample it for 15 s (at most every 30 minutes) and log where the
 * time goes: the hottest functions of Bunko's own code, as compiled positions. They are mapped
 * back to source files from the same build (scripts/perf/map-profile.mjs). No data is logged.
 */
let profiledAt = 0;
async function profileBusyWindow() {
  if (Date.now() - profiledAt < 30 * 60_000 || process.env.BUNKO_PROFILE === 'off') return;
  profiledAt = Date.now();
  const running = [...state.active.values()].join(', ') || 'no background job';
  try {
    const { Session } = await import('node:inspector/promises');
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 2000 });
    await session.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const { profile } = (await session.post('Profiler.stop')) as {
      profile: {
        nodes: {
          id: number;
          callFrame: {
            functionName: string;
            url: string;
            lineNumber: number;
            columnNumber: number;
          };
          children?: number[];
        }[];
        samples: number[];
      };
    };
    session.disconnect();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const counts = new Map<number, number>();
    for (const sample of profile.samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
    const inclusive = new Map<string, number>();
    let busy = 0;
    for (const [id, count] of counts) {
      const top = byId.get(id)!.callFrame.functionName;
      if (top === '(idle)' || top === '(program)') continue;
      busy += count;
      const seen = new Set<string>();
      for (let cur: number | undefined = id; cur; cur = parent.get(cur)) {
        const f = byId.get(cur)!.callFrame;
        if (!f.url.includes('/.next/server/')) continue;
        const where = `${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
        if (seen.has(where)) continue;
        seen.add(where);
        inclusive.set(where, (inclusive.get(where) ?? 0) + count);
      }
    }
    const top = [...inclusive]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([where, n]) => `${Math.round((n * 100) / Math.max(busy, 1))}% ${where}`);
    console.log(
      `[bunko] profile (15 s, ${Math.round((busy * 100) / Math.max(profile.samples.length, 1))}% busy; running: ${running}): ${top.join(' | ')}`,
    );
  } catch {
    /* Profiling is best effort (inspector unavailable, already attached…). */
  }
}

/** A request in flight, named by its route (so a busy window can blame a page, not a job). */
export function trackRequest(path: string) {
  const key = state.next++;
  state.active.set(key, `request ${path.replace(/\/[0-9a-z:%-]{16,}/gi, '/…')}`);
  return () => state.active.delete(key);
}
/** Jobs running now for one account (names, without the account suffix). */
export function runningJobs(tenant: number | null) {
  const suffix = tenant === null ? '' : `#${tenant}`;
  return new Set(
    [...state.active.values()]
      .filter((v) => !v.startsWith('request ') && v.endsWith(suffix))
      .map((v) => (suffix ? v.slice(0, -suffix.length) : v)),
  );
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
