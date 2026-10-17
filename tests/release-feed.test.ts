import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/release-providers.json';
import type { ChapterRelease, UnifiedMedia } from '@/types/shared';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-release-tests-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, observeChapters } = await import('@/lib/db');
const { emptyMedia, fromMangaUpdates } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const { saveMetadata } = await import('@/lib/metadata-cache');
const feed = await import('@/lib/releases');
const providers = await import('@/lib/release-providers');
const { buildPlanning, estimateSchedule, planningQuery } = await import('@/lib/planning');
const { homeFeed, composeHome } = await import('@/lib/home');
const releaseRoute = await import('@/app/api/releases/route');
const planningRoute = await import('@/app/api/planning/route');
const homeRoute = await import('@/app/api/home/route');
const now = new Date('2026-10-16T22:00:00Z');
function work(id = 1): UnifiedMedia {
  return {
    ...emptyMedia(`anilist:${id}`, `Story ${id}`, 'MANGA'),
    anilistId: id,
    format: 'MANGA',
    genres: ['Action'],
    coverUrl: 'https://s4.anilist.co/cover.jpg',
  };
}
function release(id: number, media = work(), date = '2026-10-15T12:00:00Z'): ChapterRelease {
  return {
    id: `mangadex:${id}`,
    media,
    chapter: id,
    volume: null,
    label: `c.${id}`,
    group: 'Team',
    releasedAt: date,
    hasTime: true,
    provider: 'mangadex',
    trackedId: null,
  };
}
function request(url: string, auth = true) {
  return new Request(`http://bunko.invalid${url}`, {
    headers: auth
      ? { Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}` }
      : {},
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM chapter_releases; DELETE FROM settings; DELETE FROM metadata_cache; DELETE FROM worker_state; DELETE FROM source_flags; DELETE FROM kavita_series;',
  );
  db().prepare("INSERT INTO worker_state VALUES('release_refresh',?)").run(String(Date.now()));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network');
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
describe('public provider fixtures', () => {
  it('uses the timestamp offset calendar date within one day, falling back for old imports or invalid times', () => {
    const row = fixture.updates.results[0];
    const media = fromMangaUpdates(fixture.series);
    for (const [added, hasTime] of [
      ['2026-10-14T00:30:00+14:00', true],
      ['2026-10-16T23:30:00-12:00', true],
      ['2026-10-13T23:59:00Z', false],
      ['2026-10-17T00:01:00Z', false],
      ['invalid', false],
      ['', false],
    ] as const) {
      const result = providers.updatesRelease(
        { ...row, record: { ...row.record, time_added: { timestamp: 0, as_rfc3339: added } } },
        media,
      )!;
      expect(result.hasTime).toBe(hasTime);
      expect(result.releasedAt).toBe(
        hasTime ? new Date(added).toISOString() : row.record.release_date,
      );
    }
    expect(
      providers.updatesRelease({ ...row, record: { ...row.record, time_added: undefined } }, media)!
        .hasTime,
    ).toBe(false);
  });
  it('preserves chapter ranges and uses the nearby submission timestamp for the feed', () => {
    const r = providers.updatesRelease(
      fixture.updates.results[0],
      fromMangaUpdates(fixture.series),
    )!;
    expect(r).toMatchObject({
      chapter: null,
      volume: 3,
      label: 'v.3 c.12-14',
      releasedAt: '2026-10-15T22:00:00.000Z',
      hasTime: true,
      provider: 'mangaupdates',
      group: 'Fixture Team',
    });
    expect(r.media.format).toBe('MANHWA');
  });
  it('loads MangaDex chapter timestamps, language filters, group and artwork', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      calls.push(String(input));
      return Response.json(
        String(input).includes('/chapter?') ? fixture.dexChapters : fixture.dexManga,
      );
    });
    const items = await providers.fetchDexReleases();
    expect(items[0]).toMatchObject({
      chapter: 14,
      hasTime: true,
      releasedAt: '2026-10-15T19:30:00.000Z',
      group: 'Dex Team',
    });
    expect(items[0].media).toMatchObject({ anilistId: 99, format: 'MANHWA', adult: false });
    expect(items[0].media.coverUrl).toContain('cover.jpg');
    expect(new URL(calls[0]).searchParams.get('translatedLanguage[]')).toBe('fr');
    expect(new URL(calls[0]).searchParams.get('order[readableAt]')).toBe('desc');
    expect(new URL(calls[1]).searchParams.get('includes[]')).toBe('cover_art');
    expect(
      providers.dexRelease(
        {
          ...fixture.dexChapters.data[0],
          attributes: { ...fixture.dexChapters.data[0].attributes, isUnavailable: true },
        },
        work(),
      ),
    ).toBeNull();
  });
});
describe('release store and cursor API', () => {
  it('merges cross-provider identities and groups, retaining earliest date and ranges/specials', () => {
    const mu = { ...work(), id: 'mangaupdates:55', anilistId: null, mangaUpdatesId: '55' };
    const dex = { ...work(), id: 'mangadex:xyz', anilistId: null, mangadexId: 'xyz' };
    const items = feed.deduplicateReleases([
      { ...release(12, mu, '2026-10-14'), provider: 'mangaupdates', group: 'A', hasTime: false },
      { ...release(12, dex), volume: 3, group: 'B' },
      { ...release(99, mu), chapter: null, label: 'c.12-14' },
      { ...release(98, mu), chapter: null, label: 'Bonus A' },
      { ...release(97, mu), chapter: null, label: 'Bonus B' },
    ]);
    expect(items).toHaveLength(4);
    expect(items.find((r) => r.chapter === 12)).toMatchObject({
      releasedAt: '2026-10-14',
      group: 'A, B',
      hasTime: false,
    });
  });
  it('pages fifty at a time without gaps at identical timestamps, and rejects invalid/filter-mismatched cursors', () => {
    feed.saveReleases(Array.from({ length: 105 }, (_, i) => release(i + 1)));
    const first = feed.releasesPage({});
    const second = feed.releasesPage({ cursor: first.nextCursor! });
    const third = feed.releasesPage({ cursor: second.nextCursor! });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 5]);
    expect(new Set([...first.items, ...second.items, ...third.items].map((r) => r.id)).size).toBe(
      105,
    );
    expect(third.nextCursor).toBeNull();
    expect(() => feed.releasesPage({ cursor: 'garbage' })).toThrow('Invalid release cursor');
    expect(() => feed.releasesPage({ cursor: first.nextCursor!, kind: 'novel' })).toThrow(
      'Invalid release cursor',
    );
  });
  it('applies kind, genre and library filters and retains follow identity in provider and observed releases', () => {
    const followed = track({ media: work() });
    const manhwa = { ...work(2), format: 'MANHWA' as const, origin: 'KR' };
    feed.saveReleases([
      release(1),
      release(2, manhwa),
      release(3, { ...work(3), type: 'NOVEL', format: 'LIGHT_NOVEL', genres: ['Drama'] }),
      release(4, { ...work(4), format: 'MANHUA', origin: 'CN' }),
    ]);
    observeChapters(followed.id, [
      {
        id: 600,
        uploadDate: '2026-10-15T12:00:00Z',
        mangaId: 10,
        sourceId: '123',
        sourceName: 'Source Team',
        name: 'Chapter 8',
        number: 8,
        scanlator: null,
        volume: null,
        isDownloaded: false,
      },
    ]);
    expect(feed.releasesPage({ library: '1' }).items).toHaveLength(2);
    expect(
      feed.releasesPage({ library: '1' }).items.every((r) => r.trackedId === followed.id),
    ).toBe(true);
    for (const kind of ['manhwa', 'manhua', 'lightnovel'] as const)
      expect(feed.releasesPage({ kind }).items).toHaveLength(1);
    expect(feed.releasesPage({ kind: 'manga', genre: 'action' }).items).toHaveLength(2);
    expect(feed.releasesPage({ genre: 'Drama' }).items[0].media.type).toBe('NOVEL');
    expect(feed.releasesPage({ library: '1' }).items.some((r) => r.provider === 'source')).toBe(
      true,
    );
  });
  it('resolves unique catalog-cache title matches to openable catalog media and keeps cold MangaUpdates details', async () => {
    saveMetadata('detail:anilist:1', { ...work(), tags: [], relations: [], recommendations: [] });
    const raw = { ...work(), id: 'mangaupdates:77', anilistId: null, mangaUpdatesId: '77' };
    feed.saveReleases([release(1, raw)]);
    expect(feed.releaseStore()[0].media).toMatchObject({ id: 'anilist:1', mangaUpdatesId: '77' });
    vi.stubGlobal('fetch', async () => Response.json({ ...fixture.series, series_id: 77 }));
    const { mediaDetail } = await import('@/lib/catalog');
    expect((await mediaDetail('mangaupdates:77')).mangaUpdatesId).toBe('77');
  });
  it('bounds history and excludes future releases', () => {
    feed.saveReleases([
      release(1),
      release(2, work(), '2026-08-01'),
      release(3, work(), '2026-10-17T10:00:00Z'),
    ]);
    expect(feed.releaseStore()).toHaveLength(1);
    expect(
      (db().prepare('SELECT COUNT(*) AS n FROM chapter_releases').get() as { n: number }).n,
    ).toBe(2);
  });
  it('serves authenticated store routes and validates input without upstream waits', async () => {
    feed.saveReleases([release(1)]);
    expect((await releaseRoute.GET(request('/api/releases', false))).status).toBe(401);
    const response = await releaseRoute.GET(request('/api/releases'));
    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    expect((await releaseRoute.GET(request('/api/releases?kind=bad'))).status).toBe(400);
    expect((await planningRoute.GET(request('/api/planning?week=2026-02-30'))).status).toBe(400);
    expect((await planningRoute.GET(request('/api/planning'))).status).toBe(200);
    expect((await homeRoute.GET(request('/api/home'))).status).toBe(200);
  });
  it('reuses a persisted store after module reload without refetching', async () => {
    feed.saveReleases([release(1)]);
    vi.resetModules();
    const fresh = await import('@/lib/releases');
    expect(fresh.releasesPage({}).items).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    (await import('@/lib/db')).db().close();
  });
});
describe('weekly estimation in server local time', () => {
  it('requires three separate dates and a dominant weekday; infers a regular hour', () => {
    const history = ['2026-09-28', '2026-10-05', '2026-10-12'].map((d, i) =>
      release(i, work(), `${d}T19:15:00Z`),
    );
    expect(estimateSchedule(history)!.weekday).toBe(1);
    expect(estimateSchedule(history)!.time).toBe(
      new Date(history[0].releasedAt).getHours().toString().padStart(2, '0') + ':15',
    );
    expect(estimateSchedule(history.slice(1))).toBeNull();
    expect(estimateSchedule([history[0], { ...history[0], chapter: 5 }, history[1]])).toBeNull();
    expect(
      estimateSchedule(
        ['2026-10-01', '2026-10-02', '2026-10-03'].map((d, i) => release(i, work(), d)),
      ),
    ).toBeNull();
    expect(
      estimateSchedule(
        ['2026-08-03', '2026-08-10', '2026-08-17'].map((d, i) => release(i, work(), d)),
      ),
    ).toBeNull();
    expect(
      estimateSchedule(
        history.map((r, i) => ({
          ...r,
          releasedAt: r.releasedAt.replace('19:', `${10 + i * 2}:`),
        })),
      )!.time,
    ).toBeNull();
  });
  it('returns Mon–Sun across year boundaries and today contains actual rather than duplicate expected entries', () => {
    const history = ['2026-09-28', '2026-10-05', '2026-10-12'].map((d, i) =>
      release(i, work(), `${d}T12:00:00Z`),
    );
    const future = buildPlanning(history, '2026-10-22');
    expect(future.start).toBe('2026-10-19');
    expect(future.days[0].items[0].kind).toBe('expected');
    expect(buildPlanning(history, '2027-01-01').days.map((d) => d.date)).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
    const today = buildPlanning(history, '2026-10-12', new Date('2026-10-12T22:00:00Z'));
    expect(today.days[0].items).toHaveLength(1);
    expect(today.days[0].items[0].kind).toBe('released');
    expect(planningQuery.safeParse({ week: '2026-02-30' }).success).toBe(false);
  });
  it('uses server time zone at midnight and DST boundaries, keeping date-only provider dates intact', () => {
    const old = process.env.TZ;
    process.env.TZ = 'Europe/Paris';
    try {
      const boundary = release(1, work(), '2026-10-25T23:30:00Z');
      const plan = buildPlanning([boundary], '2026-10-26', new Date('2026-10-26T01:00:00Z'));
      expect(plan.start).toBe('2026-10-26');
      expect(plan.days[0].items[0].time).toBe('00:30');
      const sunday = buildPlanning(
        [{ ...boundary, releasedAt: '2026-10-25', hasTime: false }],
        '2026-10-25',
        new Date('2026-10-26T01:00:00Z'),
      );
      expect(sunday.days[6].items[0].time).toBeNull();
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });
});
describe('home composition and caching', () => {
  it('caps hero at eight with unique artwork, top at ten and latest at twelve per format', () => {
    const items = Array.from({ length: 70 }, (_, i) => release(i, work(i)));
    items.push(release(100, { ...work(100), type: 'NOVEL', format: 'WEB_NOVEL' }));
    const home = composeHome(
      items,
      items.map((r) => r.media),
    );
    expect(home.hero).toHaveLength(8);
    expect(home.top).toHaveLength(10);
    expect(home.latest.manga).toHaveLength(12);
    expect(home.latest.webnovel).toHaveLength(1);
    expect(composeHome([release(1, { ...work(), coverUrl: null })], []).hero).toHaveLength(0);
  });
  it('answers cold immediately and never persists an empty top or default discovery success', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } });
    });
    expect((await homeFeed()).top).toEqual([]);
    await new Promise<void>((r) => setImmediate(r));
    await homeFeed();
    await new Promise<void>((r) => setImmediate(r));
    expect(calls).toBe(2);
    expect(
      db()
        .prepare(
          "SELECT key FROM metadata_cache WHERE key LIKE 'home:top:%' OR key LIKE 'discover:%'",
        )
        .all(),
    ).toEqual([]);
  });
});
