import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiscoverQuery } from '@/types/shared';
import {
  aniFields,
  emptyMedia,
  fromAniList,
  fromMangaDex,
  fromMangaUpdates,
  type AniMedia,
  type DexManga,
} from '@/lib/media';
import { discoverQuery, media as mediaSchema } from '@/lib/validation';

const directory = mkdtempSync(path.join(tmpdir(), 'kaviseerr-catalog-'));
process.env.KAVISEERR_DATA_DIR = directory;
process.env.KAVISEERR_WORKER = 'false';
const { discover } = await import('@/lib/catalog');
const { deduplicate } = await import('@/lib/search-engine');
const { db } = await import('@/lib/db');
const { GET: discoverRoute } = await import('@/app/api/discover/route');
const { persistentSecret } = await import('@/lib/settings');
const ani: AniMedia = {
  id: 123,
  type: 'MANGA',
  format: 'MANGA',
  title: { english: 'Publication fixture', romaji: null, native: null },
  coverImage: { extraLarge: null },
  bannerImage: null,
  averageScore: null,
  status: 'RELEASING',
  chapters: null,
  siteUrl: 'https://anilist.co/manga/123',
};
const dex: DexManga = {
  id: '00000000-0000-4000-8000-000000000123',
  attributes: {
    title: { en: 'Publication fixture' },
    altTitles: [],
    description: {},
    status: 'ongoing',
    tags: [],
  },
  relationships: [],
};

describe('publication date mapping and validation', () => {
  it.each([
    [undefined, null],
    [null, null],
    [{ year: null, month: 5, day: 3 }, null],
    [{ year: 2026 }, '2026'],
    [{ year: 2026, month: null, day: 3 }, '2026'],
    [{ year: 2026, month: 5, day: null }, '2026-05'],
    [{ year: 2026, month: 5, day: 3 }, '2026-05-03'],
  ])('maps AniList %j to %s', (startDate, expected) => {
    expect(fromAniList({ ...ani, startDate }).startDate).toBe(expected);
  });
  it('requests every AniList date part and leaves Suwayomi/default dates unknown', () => {
    expect(aniFields).toContain('startDate { year month day }');
    expect(emptyMedia('suwayomi:1', 'Fixture', 'MANGA').startDate).toBeNull();
  });
  it('maps MangaDex years and absent years', () => {
    expect(fromMangaDex({ ...dex, attributes: { ...dex.attributes, year: 2025 } }).startDate).toBe(
      '2025',
    );
    expect(fromMangaDex(dex).startDate).toBeNull();
    expect(
      fromMangaDex({ ...dex, attributes: { ...dex.attributes, year: null } }).startDate,
    ).toBeNull();
  });
  it.each([
    ['2026', '2026'],
    [undefined, null],
    ['unknown', null],
    ['2026-2027', null],
  ])('maps MangaUpdates year %s', (year, expected) => {
    expect(
      fromMangaUpdates({
        series_id: 1,
        title: 'Fixture',
        url: 'https://www.mangaupdates.com/series/1',
        year,
      }).startDate,
    ).toBe(expected);
  });
  it.each([
    [null, '2026', '2026-05', '2026-05-03'],
    ['2026-05-03', '2026', null, '2026-05'],
  ])('keeps the most precise date regardless of provider order: %j', (...dates) => {
    const records = dates.map((startDate, i) => ({
      ...emptyMedia(`local:${i}`, 'Same title', 'MANGA'),
      startDate,
    }));
    const merged = deduplicate(records);
    expect(merged).toHaveLength(1);
    expect(merged[0].startDate).toBe('2026-05-03');
    expect(records.map((r) => r.startDate)).toEqual(dates);
  });
  it.each([null, '2026', '2026-05', '2026-05-03'])('accepts startDate %s', (startDate) => {
    expect(
      mediaSchema.parse({ ...emptyMedia('anilist:1', 'Fixture', 'MANGA'), startDate }).startDate,
    ).toBe(startDate);
  });
  it('defaults an omitted startDate to null for old request payloads', () => {
    const old: Partial<ReturnType<typeof emptyMedia>> = emptyMedia('anilist:1', 'Fixture', 'MANGA');
    delete old.startDate;
    expect(mediaSchema.parse(old).startDate).toBeNull();
  });
  it.each(['26', '2026-5', '2026-05-3', '2026-05-03T00:00:00Z', '', 2026])(
    'rejects malformed startDate %s',
    (startDate) => {
      expect(
        mediaSchema.safeParse({ ...emptyMedia('anilist:1', 'Fixture', 'MANGA'), startDate })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    { season: 'WINTER' },
    { season: 'winter', year: 2026 },
    { season: 'AUTUMN', year: 2026 },
    { year: 1899 },
    { year: 2101 },
    { year: 2026.5 },
    { year: 'invalid' },
    { year: '' },
  ])('rejects invalid discovery query %j', (query) => {
    expect(discoverQuery.safeParse(query).success).toBe(false);
  });
  it.each([1900, 2100])('accepts year boundary %i and coerces URL parameters', (year) => {
    expect(discoverQuery.parse({ year: String(year), season: 'WINTER' })).toMatchObject({
      year,
      season: 'WINTER',
    });
  });
});

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const calls: { query: string; variables: Record<string, number | string | string[]> }[] = [];
const dates = [
  null,
  { year: 2025, month: 12, day: 31 },
  { year: 2026, month: null, day: null },
  { year: 2026, month: 1, day: null },
  { year: 2026, month: 1, day: 1 },
  { year: 2026, month: 3, day: 31 },
  { year: 2026, month: 4, day: null },
  { year: 2026, month: 4, day: 1 },
  { year: 2026, month: 6, day: 30 },
  { year: 2026, month: 7, day: 1 },
  { year: 2026, month: 9, day: 30 },
  { year: 2026, month: 10, day: 1 },
  { year: 2026, month: 10, day: 15 },
  { year: 2026, month: 10, day: 16 },
  { year: 2026, month: 12, day: 31 },
  { year: 2027, month: null, day: null },
  { year: 2027, month: 1, day: 1 },
];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    calls.push(body);
    const v = body.variables;
    const items = dates
      .filter((date) => {
        const fuzzy = date ? date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0) : 0;
        return (
          (v.startDateGreater === undefined || fuzzy > v.startDateGreater) &&
          (v.startDateLesser === undefined || fuzzy < v.startDateLesser)
        );
      })
      .map((startDate, i) => ({ ...ani, id: i + 1, startDate }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: items } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T23:30:00Z'));
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== 'https://graphql.anilist.co')
      throw new Error('Only the local AniList fixture is allowed');
    return realFetch(base, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

describe('discovery publication ranges over local AniList fixture', () => {
  it('validates season/year at the HTTP boundary before calling AniList', async () => {
    for (const query of ['season=WINTER', 'year=2101', 'year=2026.5', 'year=2026&season=AUTUMN']) {
      const response = await discoverRoute(
        new Request(`http://localhost/api/discover?${query}`, {
          headers: {
            Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(calls).toHaveLength(0);
  });
  it('passes validated URL filters to AniList and returns mapped publication dates', async () => {
    const response = await discoverRoute(
      new Request('http://localhost/api/discover?year=2026&season=SPRING&kind=manga&sort=score', {
        headers: {
          Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls[0].variables).toMatchObject({
      startDateGreater: 20260399,
      startDateLesser: 20260700,
      country: 'JP',
      formatNot: 'NOVEL',
      sort: ['SCORE_DESC'],
    });
    expect(
      (await response.json()).items.map((m: { startDate: string | null }) => m.startDate),
    ).toEqual(['2026-04', '2026-04-01', '2026-06-30']);
  });
  it.each([
    ['WINTER', 20260099, 20260400, ['2026-01', '2026-01-01', '2026-03-31']],
    ['SPRING', 20260399, 20260700, ['2026-04', '2026-04-01', '2026-06-30']],
    ['SUMMER', 20260699, 20261000, ['2026-07-01', '2026-09-30']],
    ['FALL', 20260999, 20270000, ['2026-10-01', '2026-10-15', '2026-10-16', '2026-12-31']],
  ] as const)(
    'uses exclusive %s bounds including quarter endpoints',
    async (season, greater, lesser, expected) => {
      const page = await discover({ season, year: 2026 });
      expect(calls[0].variables).toMatchObject({
        startDateGreater: greater,
        startDateLesser: lesser,
      });
      expect(page.items.map((m) => m.startDate)).toEqual(expected);
      expect(calls[0].query).toContain('startDate_greater: $startDateGreater');
      expect(calls[0].query).toContain('startDate_lesser: $startDateLesser');
      expect(calls[0].query).toContain('$startDateGreater: FuzzyDateInt');
    },
  );
  it('includes partial-year dates and both year endpoints for year alone', async () => {
    const page = await discover({ year: 2026 });
    expect(calls[0].variables).toMatchObject({
      startDateGreater: 20259999,
      startDateLesser: 20270000,
    });
    expect(page.items.map((m) => m.startDate)).toEqual(
      expect.arrayContaining(['2026', '2026-01-01', '2026-12-31']),
    );
    expect(page.items.every((m) => m.startDate?.startsWith('2026'))).toBe(true);
  });
  it('omits unset variables instead of explicit null and includes no default date filters', async () => {
    await discover({});
    expect(calls[0].variables).toEqual({
      page: 1,
      perPage: 24,
      sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
    });
  });
  it('caps new at tomorrow UTC, excludes unknown dates and lowers the popularity floor', async () => {
    const page = await discover({ sort: 'new' });
    expect(calls[0].variables).toMatchObject({
      startDateGreater: 1,
      startDateLesser: 20261016,
      popularity: 300,
      sort: ['START_DATE_DESC', 'POPULARITY_DESC'],
    });
    expect(page.items.map((m) => m.startDate)).toContain('2026-10-15');
    expect(page.items.every((m) => m.startDate && m.startDate < '2026-10-16')).toBe(true);
  });
  it.each([
    [{ year: 2026, season: 'FALL' }, 20260999, 20261016],
    [{ year: 2026, season: 'SPRING' }, 20260399, 20260700],
    [{ year: 2025 }, 20249999, 20260000],
    [{ year: 2027 }, 20269999, 20261016],
  ] satisfies [DiscoverQuery, number, number][])(
    'intersects new with the requested range %j',
    async (query, greater, lesser) => {
      const page = await discover({ ...query, sort: 'new' });
      expect(calls[0].variables).toMatchObject({
        startDateGreater: greater,
        startDateLesser: lesser,
      });
      if (query.year === 2027) expect(page.items).toEqual([]);
    },
  );
  it('keys the cache by season/year bounds and refreshes new at UTC year rollover', async () => {
    const query: DiscoverQuery = { sort: 'new', page: 71 };
    vi.setSystemTime(new Date('2026-12-31T23:59:00Z'));
    await discover(query);
    await discover(query);
    expect(calls).toHaveLength(1);
    expect(calls[0].variables.startDateLesser).toBe(20270101);
    vi.setSystemTime(new Date('2027-01-01T00:01:00Z'));
    await discover(query);
    expect(calls).toHaveLength(2);
    expect(calls[1].variables.startDateLesser).toBe(20270102);
    await discover({ ...query, year: 2026 });
    expect(calls).toHaveLength(3);
    await discover({ ...query, year: 2026 });
    expect(calls).toHaveLength(3);
  });
  it.each([
    ['2028-02-28T23:30:00Z', 20280229],
    ['2028-02-29T23:30:00Z', 20280301],
    ['2027-02-28T23:30:00Z', 20270301],
  ])('computes tomorrow across leap/month boundaries at %s', async (today, before) => {
    vi.setSystemTime(new Date(today));
    await discover({ sort: 'new', page: 72 });
    expect(calls[0].variables.startDateLesser).toBe(before);
  });
});
