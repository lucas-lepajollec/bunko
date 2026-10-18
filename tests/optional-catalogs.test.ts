import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/optional-catalogs.json';
import books from './fixtures/openlibrary.json';
import type { SettingsPatch } from '@/types/shared';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-catalog-keys-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, indexCatalog } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { accountsDb } = await import('@/lib/accounts-store');
const { userContext } = await import('@/lib/user-context');
const { inTenant } = await import('@/lib/tenant-context');
const {
  getSettings,
  updateSettings: patchSettings,
  publicSettings,
  persistentSecret,
  secretKeys,
} = await import('@/lib/settings');
const admin = { id: 1, username: 'FixtureAdmin', role: 'admin' as const };
const updateSettings = (patch: SettingsPatch) => userContext.run(admin, () => patchSettings(patch));
const { settingsPatch } = await import('@/lib/validation');
const {
  metronRelease,
  metronMedia,
  metronDetail,
  discoverComics,
  fetchMetronReleases,
  searchComics,
  metronCover,
} = await import('@/lib/metron');
const { searchHardcover, hardcoverDetail, discoverHardcover, hardcoverMedia } =
  await import('@/lib/hardcover');
const { fetchGoogleEditions, googleBooksJson } = await import('@/lib/edition-feeds');
const { saveReleases, releaseStore } = await import('@/lib/releases');
const { rakutenDate, rakutenEdition, rakutenMedia, fetchRakutenReleases } =
  await import('@/lib/rakuten');
const { buildPlanning } = await import('@/lib/planning');
const { composeHome } = await import('@/lib/home');
const { discover, mediaDetail, withTracking } = await import('@/lib/catalog');
const coverRoute = await import('@/app/api/metron/cover/route');
const { selectedCover } = await import('@/lib/kavita-cover');
const { localImageUrl } = await import('@/lib/images');
const { search } = await import('@/lib/search-engine');
const settingsRoute = await import('@/app/api/settings/route');
const testRoute = await import('@/app/api/settings/test-provider/route');
const now = new Date('2026-10-17T12:00:00Z');
const secretPatch = {
  googleBooksApiKey: 'fixture-google-key',
  metronUsername: 'FixtureUser',
  metronPassword: 'fixture-metron-password',
  rakutenApplicationId: 'fixture-rakuten-id',
  hardcoverToken: 'fixture-hardcover-token',
};
const page = <T>(results: T[]) => ({ count: results.length, next: null, results });
function req(url: string, value: unknown, method = 'POST') {
  return new Request(`http://bunko.invalid${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  accountsDb().prepare('DELETE FROM catalog_settings').run();
  for (const table of [
    'settings',
    'metadata_cache',
    'chapter_releases',
    'tracked_media',
    'adult_overrides',
    'adult_identity_edges',
  ])
    db().prepare(`DELETE FROM ${table}`).run();
  // Reset only public pacing budgets, never private result caches across tenants.
  (
    globalThis as typeof globalThis & { __bunkoCatalogBudgets?: Map<string, number> }
  ).__bunkoCatalogBudgets?.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it('encrypts, redacts, validates and clears every optional credential through settings PATCH', async () => {
  const response = await settingsRoute.PATCH(req('/api/settings', secretPatch, 'PATCH'));
  expect(response.status).toBe(200);
  const value = await response.json();
  for (const key of [
    'googleBooksApiKey',
    'metronPassword',
    'rakutenApplicationId',
    'hardcoverToken',
  ] as const) {
    expect(secretKeys).toContain(key);
    expect(value).not.toHaveProperty(key);
    expect(value.secretsConfigured[key]).toBe(true);
    expect(getSettings()[key]).toBe(secretPatch[key]);
    expect(
      (
        accountsDb().prepare('SELECT value FROM catalog_settings WHERE key=?').get(key) as {
          value: string;
        }
      ).value,
    ).not.toContain(secretPatch[key]);
  }
  expect(userContext.run(admin, publicSettings).metronUsername).toBe('FixtureUser');
  for (const patch of [
    { googleBooksApiKey: 7 },
    { hardcoverToken: 'bad\r\nheader' },
    { metronUsername: 'name:password' },
    { rakutenApplicationId: 'spaces here' },
    { metronPassword: 'bad\0password' },
    { metronApiToken: 'bad\r\nheader' },
    { metronApiToken: 'token with spaces' },
    { unknownSecret: 'x' },
  ])
    expect(settingsPatch.safeParse(patch).success).toBe(false);
  const cleared = updateSettings(
    Object.fromEntries(Object.keys(secretPatch).map((key) => [key, ''])),
  );
  for (const key of Object.keys(secretPatch).filter((k) => k !== 'metronUsername'))
    expect(cleared.secretsConfigured[key as keyof typeof cleared.secretsConfigured]).toBe(false);
});
it('shares catalog credentials while isolating optional metadata results per tenant', async () => {
  updateSettings(secretPatch);
  await inTenant(2, async () => {
    expect(getSettings().googleBooksApiKey).toBe(secretPatch.googleBooksApiKey);
    expect(getSettings().metronPassword).toBe(secretPatch.metronPassword);
  });
  const fetcher = vi.fn(async (input: string | URL) =>
    Response.json({
      kind: 'books#volumes',
      keySeen: new URL(String(input)).searchParams.get('key'),
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const url = 'https://www.googleapis.com/books/v1/volumes?q=test';
  expect(await googleBooksJson(url, 1000)).toMatchObject({ keySeen: 'fixture-google-key' });
  await inTenant(2, async () => {
    expect(await googleBooksJson(url, 1000)).toMatchObject({ keySeen: 'fixture-google-key' });
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('adds the Google key to all six edition lanes and detail calls without persisting it in cache keys', async () => {
  updateSettings({ googleBooksApiKey: secretPatch.googleBooksApiKey });
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    expect(url.searchParams.get('key')).toBe(secretPatch.googleBooksApiKey);
    expect(url.searchParams.get('maxResults')).toBe('40');
    return Response.json(fixture.google);
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await fetchGoogleEditions()).toHaveLength(6);
  expect(await fetchGoogleEditions()).toHaveLength(6);
  expect(fetcher).toHaveBeenCalledTimes(6);
  const keys = JSON.stringify(db().prepare('SELECT key FROM metadata_cache').all());
  expect(keys).not.toContain(secretPatch.googleBooksApiKey);
});
function metronFixture() {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'metron.cloud')
      return Response.json({ data: { Page: { media: [] } }, results: [] });
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('FixtureUser:fixture-metron-password').toString('base64')}`,
    );
    if (url.pathname === '/api/series/15/') return Response.json(fixture.metronSeries);
    if (url.pathname === '/api/series/') return Response.json(page([fixture.metronSeries]));
    if (url.pathname === '/api/issue/') return Response.json(page([fixture.metronIssue]));
    throw new Error('Unexpected fixture path');
  });
}
it('maps documented Metron series/detail/issue shapes, collection units and store dates', async () => {
  updateSettings(secretPatch);
  vi.stubGlobal('fetch', metronFixture());
  expect(metronMedia(fixture.metronSeries)).toMatchObject({
    id: 'metron:15',
    format: 'COMIC',
    year: 2018,
    chapters: 10,
  });
  expect(await discoverComics({ kind: 'comic' })).toMatchObject({
    items: [{ id: 'metron:15', coverUrl: '/api/metron/cover?seriesId=15' }],
    hasNextPage: false,
  });
  expect(await searchComics('Asgardians')).toHaveLength(1);
  expect(await metronDetail(15)).toMatchObject({
    synopsis: 'Cosmic adventures.',
    coverUrl: fixture.metronIssue.image,
    tags: ['Marvel', '2019'],
  });
  const release = metronRelease(fixture.metronIssue, fixture.metronSeries)!;
  expect(release).toMatchObject({
    releasedAt: '2026-10-15',
    hasTime: false,
    label: '#1',
    unit: 'chapter',
    provider: 'metron',
  });
  expect(metronRelease({ ...fixture.metronIssue, store_date: null })).toBeNull();
  expect(
    metronRelease(fixture.metronIssue, {
      ...fixture.metronSeries,
      series_type: { name: 'Trade Paperback' },
    }),
  ).toMatchObject({ unit: 'volume', volume: 1, chapter: null });
  const items = await fetchMetronReleases(now);
  saveReleases(items);
  expect(releaseStore(now)).toHaveLength(1);
  expect(composeHome(releaseStore(now), []).latest.comic).toHaveLength(1);
  const future = { ...release, id: 'metron:51', releasedAt: '2026-10-18', chapter: 2 };
  saveReleases([future]);
  expect(releaseStore(now)).toHaveLength(1);
  expect(
    buildPlanning(releaseStore(now, true), '2026-10-17', now)
      .days.flatMap((d) => d.items)
      .some((r) => r.kind === 'expected'),
  ).toBe(true);
}, 30000);
it('loads comic artwork on demand with authentication, durable reuse and warm-cache repair', async () => {
  updateSettings(secretPatch);
  const fetcher = metronFixture();
  vi.stubGlobal('fetch', fetcher);
  const found = await searchComics('Asgardians');
  expect(found[0].coverUrl).toBe('/api/metron/cover?seriesId=15');
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('q')).toBe('Asgardians');
  expect(fetcher).toHaveBeenCalledTimes(1); // No eager per-series lookup on search/discovery.
  const request = (id: string, authenticated = true) =>
    new Request(`http://bunko.invalid/api/metron/cover?seriesId=${id}`, {
      headers: authenticated
        ? { Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}` }
        : {},
    });
  expect((await coverRoute.GET(request('15', false))).status).toBe(401);
  expect((await coverRoute.GET(request('-1'))).status).toBe(400);
  const responses = await Promise.all([
    coverRoute.GET(request('15')),
    coverRoute.GET(request('15')),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(fixture.metronIssue.image);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect([...response.headers.values()].join(' ')).not.toContain(secretPatch.metronPassword);
  }
  expect(fetcher).toHaveBeenCalledTimes(2); // Both consumers share the same cached issue page.
  const old = { ...emptyMedia('metron:15', 'Asgardians', 'MANGA'), format: 'COMIC' as const };
  expect(withTracking([old])[0].coverUrl).toBe('/api/metron/cover?seriesId=15');
  expect(await metronCover(15)).toBe(fixture.metronIssue.image);
  expect(fetcher).toHaveBeenCalledTimes(2);
}, 15000);
it('never redirects comic artwork to untrusted URLs or another series and isolates credential changes', async () => {
  updateSettings({ metronApiToken: 'fixture-old-token' });
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    return Response.json(
      page(
        auth === 'Bearer fixture-old-token'
          ? [fixture.metronIssue]
          : [
              { ...fixture.metronIssue, image: 'https://evil.invalid/cover.jpg' },
              {
                ...fixture.metronIssue,
                image: 'https://static.metron.cloud@evil.invalid/cover.jpg',
              },
              { ...fixture.metronIssue, series: { id: 16 } },
            ],
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await metronCover(15)).toBe(fixture.metronIssue.image);
  updateSettings({ metronApiToken: 'fixture-new-token' });
  expect(await metronCover(15)).toBeNull();
  expect(await metronCover(15)).toBeNull();
  const missing = await coverRoute.GET(
    new Request('http://bunko.invalid/api/metron/cover?seriesId=15', {
      headers: { Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}` },
    }),
  );
  expect(missing.status).toBe(404);
  expect(missing.headers.get('location')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
}, 15000);
it('retains a selected comic card cover for imports without forwarding Metron auth to its CDN', async () => {
  updateSettings(secretPatch);
  const metadata = metronFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'static.metron.cloud') {
        expect(init?.headers).toBeUndefined();
        return new Response('fixture-jpeg', { headers: { 'Content-Type': 'image/jpeg' } });
      }
      return metadata(input, init);
    }),
  );
  const url = '/api/metron/cover?seriesId=15';
  expect(localImageUrl(url)).toBe(true);
  expect(localImageUrl(`${url}&url=https://evil.invalid`)).toBe(false);
  expect(localImageUrl('/api/metron/cover?seriesId=-1')).toBe(false);
  expect((await selectedCover(url))?.bytes.toString()).toBe('fixture-jpeg');
  expect(metadata).toHaveBeenCalledTimes(1);
});
it('searches every enabled catalog and local titles without a format restriction', async () => {
  updateSettings(secretPatch);
  const wn = {
    ...emptyMedia('local:web', 'Fixture Web Novel', 'NOVEL'),
    format: 'WEB_NOVEL' as const,
  };
  track({ media: wn, autoDownload: false });
  indexCatalog([
    {
      suwayomiMangaId: 501,
      sourceId: '9007199254740993',
      sourceName: 'Fixture FR',
      thumbnailUrl: null,
      lang: 'fr',
      title: 'Fixture source manga',
      mangaUrl: '/fixture',
    },
  ]);
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'metron.cloud') return Response.json(page([fixture.metronSeries]));
    if (url.hostname === 'api.hardcover.app')
      return Response.json({
        data: { search: { results: { hits: [{ document: fixture.hardcoverBook }] } } },
      });
    if (url.hostname === 'openlibrary.org') return Response.json(books.search);
    if (url.hostname === 'graphql.anilist.co') {
      expect(JSON.parse(String(init?.body)).variables).toMatchObject({
        search: 'Fixture',
        type: 'MANGA',
      });
      return Response.json({
        data: {
          Page: {
            media: [
              {
                id: 900,
                title: { romaji: 'Fixture Manga' },
                format: 'MANGA',
                countryOfOrigin: 'JP',
              },
              {
                id: 901,
                title: { romaji: 'Fixture Manhwa' },
                format: 'MANGA',
                countryOfOrigin: 'KR',
              },
              {
                id: 902,
                title: { romaji: 'Fixture Light Novel' },
                format: 'NOVEL',
                countryOfOrigin: 'JP',
              },
            ].map((m) => ({ ...m, coverImage: { extraLarge: null } })),
          },
        },
      });
    }
    if (url.hostname === 'api.mangadex.org')
      return Response.json({
        data: [
          {
            id: 'fixture-dex',
            attributes: {
              title: { en: 'Fixture Dex' },
              altTitles: [],
              description: {},
              tags: [],
              originalLanguage: 'ja',
            },
            relationships: [],
          },
        ],
      });
    if (url.hostname === 'api.mangaupdates.com')
      return Response.json({
        results: [{ record: { series_id: 903, title: 'Fixture Manhua', type: 'Manhua' } }],
      });
    throw new Error('Unexpected catalog request');
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await search('Fixture');
  expect(result.results.map((m) => m.id)).toEqual(
    expect.arrayContaining([
      'anilist:900',
      'anilist:901',
      'anilist:902',
      'mangadex:fixture-dex',
      'mangaupdates:903',
      'metron:15',
      'hardcover:123',
      'openlibrary:OL27448W',
      'local:web',
      'suwayomi:501',
    ]),
  );
  expect(result.results.map((m) => m.format)).toEqual(
    expect.arrayContaining([
      'MANGA',
      'MANHWA',
      'MANHUA',
      'COMIC',
      'LIGHT_NOVEL',
      'WEB_NOVEL',
      'NOVEL',
      'BOOK',
    ]),
  );
  expect(result.providers.every((p) => p.status === 'ok')).toBe(true);
  const requests = fetcher.mock.calls.length;
  expect((await search('Fixture', undefined, undefined, true)).results).toEqual(result.results);
  expect(fetcher).toHaveBeenCalledTimes(requests);
}, 15000);
it('connects comic discovery, search and detail to their API implementations', async () => {
  updateSettings(secretPatch);
  vi.stubGlobal('fetch', metronFixture());
  expect((await discover({ kind: 'comic' })).items[0]?.id).toBe('metron:15');
  expect((await mediaDetail('metron:15')).chapters).toBe(10);
  expect((await search('Asgardians', 'MANGA')).results.some((m) => m.id === 'metron:15')).toBe(
    true,
  );
}, 20000);
it('uses Hardcover Bearer GraphQL search, discovery, series and edition dates', async () => {
  updateSettings(secretPatch);
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-hardcover-token',
    );
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('BunkoSearch'))
      return Response.json({
        data: { search: { results: { hits: [{ document: fixture.hardcoverBook }] } } },
      });
    if (body.query.includes('BunkoDiscover')) {
      expect(body.query).not.toMatch(/_ilike|_like/);
      return Response.json({ data: { books: [fixture.hardcoverRecord] } });
    }
    return Response.json({ data: { books_by_pk: fixture.hardcoverRecord } });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(hardcoverMedia(fixture.hardcoverBook)).toMatchObject({
    format: 'NOVEL',
    startDate: '2026-10-15',
    score: 84,
  });
  expect(await searchHardcover('Example')).toHaveLength(1);
  expect((await discoverHardcover({ kind: 'novel' })).items).toHaveLength(1);
  const detail = await hardcoverDetail(123);
  expect(detail.tags).toContain('Example Saga #2');
  expect(detail.tags.some((t) => t.includes('2026-11-01'))).toBe(true);
  await hardcoverDetail(123);
  expect(fetcher).toHaveBeenCalledTimes(3);
}, 10000);
it('keeps optional providers disabled without credentials and validates the test-provider boundary', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await searchComics('x')).toEqual([]);
  expect(await searchHardcover('x')).toEqual([]);
  expect(await fetchMetronReleases()).toEqual([]);
  for (const provider of ['googlebooks', 'metron', 'rakuten', 'hardcover']) {
    const response = await testRoute.POST(req('/api/settings/test-provider', { provider }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('PROVIDER_UNCONFIGURED');
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (await testRoute.POST(req('/api/settings/test-provider', { provider: 'other' }))).status,
  ).toBe(400);
  expect(
    (
      await testRoute.POST(
        new Request('http://bunko.invalid/api/settings/test-provider', { method: 'POST' }),
      )
    ).status,
  ).toBe(401);
});
it('sanitizes provider test errors and cools down failed authenticated calls', async () => {
  updateSettings(secretPatch);
  const fetcher = vi.fn(
    async () => new Response('do not echo fixture-hardcover-token', { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const response = await testRoute.POST(
    req('/api/settings/test-provider', { provider: 'hardcover' }),
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_AUTH_FAILED' } });
  expect(
    (await testRoute.POST(req('/api/settings/test-provider', { provider: 'hardcover' }))).status,
  ).toBe(502);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves Japanese date precision, marks Japan and plans only exact Rakuten volume dates', async () => {
  const row = fixture.rakuten.Items[0].Item;
  expect(rakutenDate('2026年10月15日')).toBe('2026-10-15');
  expect(rakutenDate('2026年10月下旬')).toBe('2026-10');
  expect(rakutenDate('2026年')).toBe('2026');
  expect(rakutenDate('2026年02月30日')).toBeNull();
  expect(rakutenMedia({ ...row, salesDate: '2026年10月' }).startDate).toBe('2026-10');
  expect(rakutenEdition({ ...row, salesDate: '2026年10月下旬' })).toBeNull();
  const release = rakutenEdition(row)!;
  expect(release).toMatchObject({
    unit: 'volume',
    volume: 14,
    hasTime: false,
    group: 'Japon / Japan · KADOKAWA',
    media: { format: 'LIGHT_NOVEL', origin: 'JP' },
  });
  const future = { ...release, releasedAt: '2026-10-18' };
  expect(buildPlanning([future], '2026-10-17', now).days.flatMap((d) => d.items)[0].kind).toBe(
    'expected',
  );
  updateSettings({ rakutenApplicationId: 'fixture-id' });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchRakutenReleases()).rejects.toMatchObject({
    code: 'PROVIDER_ACCESS_KEY_REQUIRED',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('queries Rakuten current endpoint with both credentials and the Books LN/manga genre IDs', async () => {
  updateSettings({ rakutenApplicationId: 'fixture-id' });
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('openapi.rakuten.co.jp');
    expect(url.searchParams.get('sort')).toBe('-releaseDate');
    expect(['001017', '001001']).toContain(url.searchParams.get('booksGenreId'));
    expect((init?.headers as Record<string, string>).accessKey).toBe('fixture-access-key');
    return Response.json(fixture.rakuten);
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await fetchRakutenReleases('fixture-access-key')).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(db().prepare('SELECT key FROM metadata_cache').all())).not.toContain(
    'fixture-access-key',
  );
});

it('returns only status from successful provider credential probes', async () => {
  updateSettings(secretPatch);
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const host = new URL(String(input)).hostname;
    if (host === 'metron.cloud') return Response.json(page([]));
    if (host === 'www.googleapis.com') return Response.json({ kind: 'books#volumes', items: [] });
    return Response.json({ data: { me: [{ id: 987, username: 'private-account' }] } });
  });
  for (const provider of ['googlebooks', 'metron', 'hardcover']) {
    const response = await testRoute.POST(req('/api/settings/test-provider', { provider }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, provider });
  }
});
it('respects Retry-After across distinct provider queries without exposing response bodies', async () => {
  updateSettings(secretPatch);
  const fetcher = vi.fn(
    async () =>
      new Response('private upstream details', { status: 429, headers: { 'Retry-After': '120' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(searchComics('one')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  await expect(searchComics('two')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('accepts exact catalog cover hosts for retained covers and rejects lookalikes and embedded credentials', async () => {
  const { allowedCoverUrl } = await import('@/lib/kavita-cover');
  for (const host of [
    'books.google.com',
    'static.metron.cloud',
    'assets.hardcover.app',
    'thumbnail.image.rakuten.co.jp',
  ]) {
    expect(allowedCoverUrl(`https://${host}/cover.jpg`)).toBe(true);
    expect(allowedCoverUrl(`https://${host}.evil.invalid/cover.jpg`)).toBe(false);
    expect(allowedCoverUrl(`https://user:password@${host}/cover.jpg`)).toBe(false);
  }
});
