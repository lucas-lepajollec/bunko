/**
 * Background health check of the free streams of the channel index: Lives only shows the
 * channels that really play from this server (see `health.ts`). One loop for the whole server
 * (the index is shared): the countries people browse first, then every other channel, each
 * checked again after a day. Results are kept per stream address so a new index keeps them.
 */
import { probeStream } from './health';
import { liveDb } from './store';

interface StoredStream {
  u: string;
  r?: string;
  a?: string;
}
const RECHECK_MS = 24 * 3600_000;
const CONCURRENCY = 8;
const BATCH = 48;
/** A channel tries at most this many of its streams before it is counted as not playing. */
const STREAMS_PER_CHANNEL = 3;

const scope = globalThis as typeof globalThis & {
  __bunkoLiveHealth?: {
    running: boolean;
    priority: Set<string>;
    stop?: AbortController;
  };
};
const state = (scope.__bunkoLiveHealth ??= { running: false, priority: new Set(['FR']) });

const headersOf = (s: StoredStream) => {
  const h: Record<string, string> = {};
  if (s.r) h.Referer = s.r;
  if (s.a) h['User-Agent'] = s.a;
  return h;
};

/** Health of known stream addresses: ok, failed, or unknown (not in the map). */
export function streamHealth(urls: string[]) {
  const out = new Map<string, boolean>();
  if (!urls.length) return out;
  const rows = liveDb()
    .prepare(
      `SELECT url, ok FROM live_health WHERE url IN (${urls.map(() => '?').join(',')}) AND checked_at > ?`,
    )
    .all(...urls, Date.now() - 2 * RECHECK_MS) as { url: string; ok: number }[];
  for (const r of rows) out.set(r.url, r.ok === 1);
  return out;
}

/** After an index update: each channel's state from what its streams did before. */
export function restoreHealth() {
  const db = liveDb();
  const health = new Map(
    (
      db
        .prepare('SELECT url, ok, checked_at FROM live_health WHERE checked_at > ?')
        .all(Date.now() - 2 * RECHECK_MS) as { url: string; ok: number; checked_at: number }[]
    ).map((r) => [r.url, r]),
  );
  const update = db.prepare('UPDATE live_channels SET verified=?, checked_at=? WHERE id=?');
  db.transaction(() => {
    for (const row of db
      .prepare('SELECT id, streams FROM live_channels WHERE playable=1')
      .all() as { id: string; streams: string }[]) {
      const known = (JSON.parse(row.streams) as StoredStream[])
        .slice(0, STREAMS_PER_CHANNEL)
        .map((s) => health.get(s.u))
        .filter((h) => h !== undefined);
      if (!known.length) continue;
      update.run(
        known.some((h) => h.ok) ? 1 : 0,
        Math.max(...known.map((h) => h.checked_at)),
        row.id,
      );
    }
  })();
}

/** Plays a channel's streams in order until one works; records each answer. */
export async function checkChannel(id: string, signal?: AbortSignal) {
  const db = liveDb();
  const row = db.prepare('SELECT streams FROM live_channels WHERE id=?').get(id) as
    { streams: string } | undefined;
  if (!row) return false;
  const record = db.prepare(
    'INSERT OR REPLACE INTO live_health(url, ok, reason, checked_at) VALUES(?,?,?,?)',
  );
  let ok = false;
  for (const s of (JSON.parse(row.streams) as StoredStream[]).slice(0, STREAMS_PER_CHANNEL)) {
    const result = await probeStream(s.u, headersOf(s), signal);
    record.run(s.u, result.ok ? 1 : 0, result.ok ? null : result.reason, Date.now());
    if (result.ok) {
      ok = true;
      break;
    }
  }
  db.prepare('UPDATE live_channels SET verified=?, checked_at=? WHERE id=?').run(
    ok ? 1 : 0,
    Date.now(),
    id,
  );
  return ok;
}

/** A player gave up on every source of a free channel: it is checked again right away. */
export function reportFailure(id: string) {
  liveDb().prepare('UPDATE live_channels SET checked_at=0 WHERE id=? AND playable=1').run(id);
  startHealthChecks();
}

/** Countries checked first (the ones people's homes show). */
export function prioritise(countries: string[]) {
  for (const c of countries) state.priority.add(c);
}

function nextBatch(): string[] {
  const priority = [...state.priority].filter((c) => /^[A-Z]{2}$/.test(c));
  const first = priority.length
    ? `CASE WHEN country IN (${priority.map((c) => `'${c}'`).join(',')}) THEN 0 ELSE 1 END,`
    : '';
  return (
    liveDb()
      .prepare(
        `SELECT id FROM live_channels WHERE playable=1 AND checked_at < ?
         ORDER BY ${first} checked_at, id LIMIT ${BATCH}`,
      )
      .all(Date.now() - RECHECK_MS) as { id: string }[]
  ).map((r) => r.id);
}

/** How far the check went: channels with free streams, and how many were played. */
export function healthProgress() {
  const row = liveDb()
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN checked_at > 0 THEN 1 ELSE 0 END) AS checked,
       SUM(verified) AS working FROM live_channels WHERE playable=1`,
    )
    .get() as { total: number; checked: number | null; working: number | null };
  return { total: row.total, checked: row.checked ?? 0, working: row.working ?? 0 };
}

/** Starts the loop when it is not running (tests start it only when they ask). */
export function startHealthChecks() {
  if (state.running || (process.env.VITEST && process.env.BUNKO_LIVE_HEALTH !== '1')) return;
  state.running = true;
  state.stop = new AbortController();
  const signal = state.stop.signal;
  void (async () => {
    try {
      for (;;) {
        const batch = nextBatch();
        if (!batch.length || signal.aborted) break;
        let at = 0;
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
            while (at < batch.length && !signal.aborted) {
              const id = batch[at++];
              await checkChannel(id, signal).catch(() => undefined);
            }
          }),
        );
      }
    } finally {
      state.running = false;
    }
  })();
}
export function stopHealthChecks() {
  state.stop?.abort();
}
