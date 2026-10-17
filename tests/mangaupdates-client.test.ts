import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/release-providers.json';
import real from './fixtures/mangaupdates-real.json';
// Node's timers/promises is not virtualized by Vitest; keep abort semantics while driving the clock.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    }),
}));
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-mu-client-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { mangaUpdates, BUNKO_USER_AGENT } = await import('@/lib/mangaupdates');
const { fetchUpdatesReleases } = await import('@/lib/release-providers');
const { refreshReleases, releasesPage, saveReleases } = await import('@/lib/releases');
const { emptyMedia } = await import('@/lib/media');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { updateSettings } = await import('@/lib/settings');
const { releaseStore, mediaKind } = await import('@/lib/releases');
const { buildPlanning } = await import('@/lib/planning');
const { composeHome } = await import('@/lib/home');
const scope = globalThis as typeof globalThis & { __bunkoMuNext?: number };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  delete scope.__bunkoMuNext;
  db().exec(
    'DELETE FROM chapter_releases;DELETE FROM metadata_cache;DELETE FROM worker_state;DELETE FROM tracked_media;DELETE FROM settings;',
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('real MangaUpdates release ingestion', () => {
  function stored() {
    return (
      db().prepare('SELECT payload FROM chapter_releases').all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  function route(input: string | URL) {
    const url = new URL(input);
    if (url.hostname === 'api.mangadex.org')
      return Response.json(url.pathname === '/chapter' ? fixture.dexChapters : fixture.dexManga);
    if (url.pathname === '/v1/releases/days')
      return Response.json(url.searchParams.get('page') === '1' ? real.updates : { results: [] });
    const record = real.series.find((r) => url.pathname === `/v1/series/${r.series_id}`);
    if (!record) throw new Error('Unexpected fixture request');
    return Response.json(record);
  }
  it('refreshes real daily/series shapes into SQLite, all four kinds, adult visibility, home and planning', async () => {
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    vi.stubGlobal('fetch', route);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const job = refreshReleases();
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    const mu = stored().filter((r) => r.provider === 'mangaupdates');
    expect(mu).toHaveLength(4); // Null series metadata is skipped.
    expect(mu.map((r) => mediaKind(r.media)).sort()).toEqual([
      'lightnovel',
      'manga',
      'manhua',
      'manhwa',
    ]);
    const coral = mu.find((r) => r.media.mangaUpdatesId === '75449291507');
    expect(coral).toMatchObject({
      hasTime: true,
      releasedAt: '2026-10-16T21:04:54.000Z',
      media: { adult: true, format: 'MANHWA' },
    });
    expect(coral.media.genres).toEqual(expect.arrayContaining(['Smut', 'Mature']));
    expect(releaseStore().some((r) => r.id === coral.id)).toBe(false);
    updateSettings({ adultContent: true });
    const visible = releaseStore();
    expect(visible.some((r) => r.id === coral.id)).toBe(true);
    expect(composeHome(visible, []).latest.lightnovel).toHaveLength(1);
    const timestamps = visible.map((r) => Date.parse(r.releasedAt));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    const dexIndex = visible.findIndex((r) => r.provider === 'mangadex');
    expect(dexIndex).toBeGreaterThan(0);
    expect(dexIndex).toBeLessThan(visible.length - 1);
    const oldZone = process.env.TZ;
    process.env.TZ = 'Europe/Paris';
    try {
      const plan = buildPlanning([coral], '2026-10-16', new Date('2026-10-17T01:00:00Z'));
      expect(plan.days[4].items[0].time).toBe('23:04');
    } finally {
      if (oldZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldZone;
    }
    expect(warning).not.toHaveBeenCalled();
  });
  it('saves cached series anywhere on page 1, then completed lookups, before a slow sheet finishes', async () => {
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    const novel = real.series.find((r) => r.type === 'Novel')!;
    saveMetadata(`mu:series:${novel.series_id}`, novel);
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', (input: string | URL) =>
      String(input).endsWith('/series/42106686683')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(route(input)),
    );
    const job = refreshReleases();
    let done = false;
    void job.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stored().some((r) => r.media.type === 'NOVEL')).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(stored().some((r) => r.media.mangaUpdatesId === '75449291507')).toBe(true);
    expect(stored().some((r) => r.media.mangaUpdatesId === '42106686683')).toBe(false);
    expect(done).toBe(false);
    finish(route('https://api.mangaupdates.com/v1/series/42106686683'));
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(stored().filter((r) => r.provider === 'mangaupdates')).toHaveLength(4);
  });
  it('preserves partial rows and logs exactly one safe line when series and another provider fail', async () => {
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', (input: string | URL) => {
      if (
        String(input).includes('api.mangadex.org') ||
        String(input).endsWith('/series/42106686683')
      )
        throw new Error('https://secret.invalid/?token=private Bearer private\nupstream body');
      return route(input);
    });
    const job = refreshReleases();
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(stored().filter((r) => r.provider === 'mangaupdates')).toHaveLength(3);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[releases] refresh incomplete: mangaupdates=UPSTREAM_ERROR (1); mangadex=UPSTREAM_ERROR (1)',
    );
  });
  it('saves stale sheets immediately and reports failed revalidation instead of swallowing it in SWR', async () => {
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    for (const record of real.series)
      saveMetadata(`mu:series:${record.series_id}`, record, Date.now() - 8 * 86400_000);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', (input: string | URL) =>
      String(input).endsWith('/series/75449291507')
        ? new Response(null, { status: 503 })
        : route(input),
    );
    const job = refreshReleases();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored().filter((r) => r.provider === 'mangaupdates')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(stored().filter((r) => r.provider === 'mangaupdates')).toHaveLength(4);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[releases] refresh incomplete: mangaupdates=METADATA_UNAVAILABLE/HTTP_503 (1)',
    );
  });
  it('continues historical backfill after a current-page sheet fails', async () => {
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/series/42106686683')) return new Response(null, { status: 404 });
      if (url.pathname === '/v1/releases/days' && url.searchParams.get('page') === '2')
        return Response.json({
          results: [
            {
              ...real.updates.results[1],
              record: {
                ...real.updates.results[1].record,
                id: 990001,
                chapter: '11',
              },
            },
          ],
        });
      return route(input);
    });
    const job = refreshReleases();
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(stored().some((r) => r.id === 'mangaupdates:990001')).toBe(true);
    expect(
      db().prepare("SELECT value FROM worker_state WHERE key='release_backfill'").get(),
    ).toEqual({ value: '3' });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[releases] refresh incomplete: mangaupdates=METADATA_UNAVAILABLE/HTTP_404 (1)',
    );
  });
  it('fills the current listing past forty uncached series and caches late series without a lookup', async () => {
    const base = real.updates.results[1];
    const rows = Array.from({ length: 45 }, (_, i) => ({
      ...base,
      record: { ...base.record, id: 10000 + i },
      metadata: { series: { series_id: 10000 + i } },
    }));
    const novel = real.series.find((r) => r.type === 'Novel')!;
    saveMetadata('mu:series:10044', { ...novel, series_id: 10044 });
    const sheets: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL) => {
      const url = new URL(input);
      if (url.hostname === 'api.mangadex.org') return Response.json({ data: [] });
      if (url.pathname === '/v1/releases/days')
        return Response.json({ results: url.searchParams.get('page') === '1' ? rows : [] });
      sheets.push(url.pathname);
      const id = Number(url.pathname.split('/').pop());
      return Response.json({ ...real.series[0], series_id: id, title: `Budget fixture ${id}` });
    });
    const job = refreshReleases();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored().some((r) => r.media.type === 'NOVEL')).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000);
    await job;
    expect(stored()).toHaveLength(45);
    expect(sheets).toHaveLength(44);
    expect(sheets).not.toContain('/v1/series/10044');
  });
});
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
describe('MangaUpdates courtesy and persistent metadata', () => {
  it('serializes, identifies Bunko and respects Retry-After on 429', async () => {
    const calls: { at: number; agent: string | null }[] = [];
    let active = 0;
    let maximum = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      active++;
      maximum = Math.max(maximum, active);
      calls.push({ at: Date.now(), agent: new Headers(init.headers).get('User-Agent') });
      await Promise.resolve();
      active--;
      return calls.length === 1
        ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
        : Response.json({ ok: true });
    });
    const at = Date.now();
    const a = mangaUpdates('/series/1');
    const b = mangaUpdates('/series/2');
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([a, b]);
    expect(maximum).toBe(1);
    expect(calls.map((c) => c.at - at)).toEqual([0, 2000, 3000]);
    expect(calls.every((c) => c.agent === BUNKO_USER_AGENT)).toBe(true);
  });
  it('bounds retry attempts without spinning and honors HTTP date retry headers', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': new Date(Date.now() + 3000).toUTCString() },
      });
    });
    const failure = mangaUpdates('/series/1').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await failure).toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toBe(3);
  });
  it('does not shorten a long Retry-After cooldown', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const failure = mangaUpdates('/series/1').catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await failure).toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const again = mangaUpdates('/series/2').catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await again).toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels a queued request without making an upstream call', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const first = mangaUpdates('/series/1');
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const second = mangaUpdates('/series/2', { signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect(await second).toMatchObject({ name: 'AbortError' });
    finish(Response.json({ ok: true }));
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the public daily listing and reuses persistent series sheets', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      urls.push(String(input));
      return Response.json(
        String(input).includes('/releases/days') ? fixture.updates : fixture.series,
      );
    });
    const first = fetchUpdatesReleases(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toHaveLength(1);
    const second = fetchUpdatesReleases(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await second).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/series/12345'))).toHaveLength(1);
    expect(
      urls.filter((u) => u.includes('/releases/days?include_metadata=true&page=1')),
    ).toHaveLength(2);
    expect(
      (
        db()
          .prepare("SELECT COUNT(*) AS n FROM metadata_cache WHERE key='mu:series:12345'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });
  it('coalesces background refresh, serves existing releases immediately, and persists the attempt throttle', async () => {
    let unblock!: () => void;
    const hold = new Promise<void>((r) => {
      unblock = r;
    });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      await hold;
      return Response.json({ results: [], data: [] });
    });
    saveReleases([
      {
        id: 'mangaupdates:1',
        media: emptyMedia('anilist:1', 'Fixture', 'MANGA'),
        chapter: 1,
        volume: null,
        label: 'c.1',
        group: null,
        releasedAt: '2026-10-15',
        hasTime: false,
        provider: 'mangaupdates',
        trackedId: null,
      },
    ]);
    const first = refreshReleases();
    const second = refreshReleases();
    expect(first).toBe(second);
    expect(releasesPage({}).items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    unblock();
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    expect(calls).toBe(3);
    await refreshReleases();
    expect(calls).toBe(3);
  });
});
