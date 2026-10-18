import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/release-providers.json';
import type { AniMedia } from '@/lib/media';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-adult-tests-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant, settleCatalogTasks } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, untrack, listTracked, indexCatalog, observeChapters } = await import('@/lib/db');
const { emptyMedia, fromAniList, fromMangaDex, fromMangaUpdates } = await import('@/lib/media');
const { recordSourceFlags, mediaAdult } = await import('@/lib/adult');
const { getSettings, updateSettings, persistentSecret } = await import('@/lib/settings');
const { settingsPatch } = await import('@/lib/validation');
const { discover, mediaDetail } = await import('@/lib/catalog');
const { search } = await import('@/lib/search-engine');
const { setSourcePreferences } = await import('@/lib/source-preferences');
const { sources, sourceInfos, searchSource, browseSource } = await import('@/lib/suwayomi');
const { matchOnSource } = await import('@/lib/matching');
const { updatesFeed } = await import('@/lib/updates');
const { saveReleases, releasesPage } = await import('@/lib/releases');
const { planning } = await import('@/lib/planning');
const { homeFeed } = await import('@/lib/home');
const { saveMetadata } = await import('@/lib/metadata-cache');
const trackedRoute = await import('@/app/api/tracked/route');
const streamRoute = await import('@/app/api/search/stream/route');
const syncRoute = await import('@/app/api/catalog/sync/route');
const adultRoute = await import('@/app/api/media/adult/route');
const detailRoute = await import('@/app/api/media/route');
const { libraryActivity } = await import('@/lib/library-activity');
const settingsRoute = await import('@/app/api/settings/route');
const { kavitaMedia } = await import('@/lib/kavita-track');
const { syncKavitaIndex, kavitaSummaries } = await import('@/lib/kavita-index');
const normal = {
  ...emptyMedia('anilist:1', 'Ordinary Story', 'MANGA'),
  anilistId: 1,
  coverUrl: 'https://s4.anilist.co/cover.jpg',
  format: 'MANGA' as const,
};
const adult = { ...normal, id: 'anilist:2', anilistId: 2, title: 'Explicit Story', adult: true };
const nsfw = { id: '9223372036854775806', name: 'NSFW source', lang: 'fr', nsfw: true };
const safe = { id: '123', name: 'Safe source', lang: 'fr', nsfw: false };
const ani = (id: number, isAdult = false): AniMedia => ({
  id,
  isAdult,
  type: 'MANGA',
  format: 'MANGA',
  title: { english: id === 1 ? normal.title : adult.title, romaji: null, native: null },
  coverImage: { extraLarge: normal.coverUrl },
  bannerImage: null,
  averageScore: null,
  status: null,
  chapters: null,
  siteUrl: `https://anilist.co/manga/${id}`,
});
function request(url: string, body?: unknown, method = 'GET') {
  return new Request(`http://bunko.invalid${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function seedReleases() {
  saveReleases(
    [normal, adult].map((media, i) => ({
      id: `mangadex:${i}`,
      media,
      chapter: 1,
      volume: null,
      label: 'c.1',
      group: null,
      releasedAt: '2026-10-15T12:00:00Z',
      hasTime: true,
      provider: 'mangadex',
      trackedId: null,
    })),
  );
}
let requests: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  db().exec(
    'DELETE FROM adult_overrides;DELETE FROM adult_identity_edges;DELETE FROM tracked_media;DELETE FROM settings;DELETE FROM chapter_releases;DELETE FROM source_flags;DELETE FROM metadata_cache;DELETE FROM worker_state;DELETE FROM catalog_fts;DELETE FROM catalog_keys;DELETE FROM kavita_series;',
  );
  db().prepare("INSERT INTO worker_state VALUES('release_refresh',?)").run(String(Date.now()));
  updateSettings({ suwayomiUrl: 'http://source.invalid', autoImportKavita: false });
  setSourcePreferences({ enabledSourceIds: [], languages: ['fr'] });
  requests = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, body });
    if (url.includes('graphql.anilist')) {
      if (String(body.query).includes('Media(id:'))
        return Response.json({
          data: {
            Media: {
              ...ani(Number(body.variables.id), Number(body.variables.id) === 2),
              tags: [],
              relations: { edges: [{ relationType: 'SEQUEL', node: ani(2, true) }] },
              recommendations: {
                nodes: [{ mediaRecommendation: ani(2, true) }, { mediaRecommendation: ani(1) }],
              },
            },
          },
        });
      return Response.json({
        data: { Page: { pageInfo: { hasNextPage: false }, media: [ani(1), ani(2, true)] } },
      });
    }
    if (url.includes('api.mangadex.org'))
      return Response.json({
        data: [
          {
            ...fixture.dexManga.data[0],
            attributes: {
              ...fixture.dexManga.data[0].attributes,
              title: { en: 'Dex Explicit' },
              contentRating: 'pornographic',
            },
          },
        ],
      });
    if (url.includes('mangaupdates'))
      return Response.json({
        results: [
          { record: { ...fixture.series, title: 'MU Explicit', genres: [{ genre: 'Smut' }] } },
        ],
      });
    if (url === 'http://source.invalid/api/graphql') {
      if (String(body.query).includes('query { sources'))
        return Response.json({
          data: {
            sources: {
              nodes: [
                { ...safe, isNsfw: false },
                { ...nsfw, isNsfw: true },
              ],
            },
          },
        });
      if (String(body.query).includes('fetchSourceManga'))
        return Response.json({
          data: {
            fetchSourceManga: {
              mangas: [{ id: 10, title: 'Fixture', url: '/fixture', thumbnailUrl: null }],
              hasNextPage: false,
            },
          },
        });
    }
    throw new Error('Unexpected upstream');
  });
});
afterEach(async () => {
  await settleCatalogTasks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
describe('adult metadata and settings', () => {
  it('defaults off, validates boolean PATCH, persists and redacts settings', async () => {
    expect(getSettings().adultContent).toBe(false);
    expect(settingsPatch.safeParse({ adultContent: 'true' }).success).toBe(false);
    expect(
      (await settingsRoute.PATCH(request('/api/settings', { adultContent: true }, 'PATCH'))).status,
    ).toBe(200);
    expect(getSettings().adultContent).toBe(true);
    expect((await (await settingsRoute.GET(request('/api/settings'))).json()).adultContent).toBe(
      true,
    );
  });
  it('computes all provider flags, distinguishes Mature from Adult, and never infers title content from a source flag', () => {
    expect(fromAniList(ani(2, true)).adult).toBe(true);
    for (const contentRating of ['erotica', 'pornographic'])
      expect(
        fromMangaDex({
          ...fixture.dexManga.data[0],
          attributes: { ...fixture.dexManga.data[0].attributes, contentRating },
        }).adult,
      ).toBe(true);
    for (const genre of ['Adult', 'Hentai', 'Smut'])
      expect(fromMangaUpdates({ ...fixture.series, genres: [{ genre }] }).adult).toBe(true);
    expect(fromMangaUpdates({ ...fixture.series, genres: [{ genre: 'Mature' }] }).adult).toBe(
      false,
    );
    recordSourceFlags([safe, nsfw]);
    expect(mediaAdult(normal, [{ sourceId: nsfw.id }])).toBe(false);
    expect(mediaAdult(normal, [{ sourceId: nsfw.id }, { sourceId: safe.id }])).toBe(false);
    expect(mediaAdult(normal, [])).toBe(false);
  });
  it('hides followed adults and their counts while retaining observations and automatic-download choices', async () => {
    recordSourceFlags([nsfw]);
    const followed = track({
      media: adult,
      sources: [{ sourceId: nsfw.id, sourceName: nsfw.name, suwayomiMangaId: 10 }],
      autoDownload: true,
    });
    track({ media: normal });
    observeChapters(followed.id, [
      {
        id: 100,
        mangaId: 10,
        sourceId: nsfw.id,
        sourceName: nsfw.name,
        name: 'c.1',
        number: 1,
        scanlator: null,
        volume: null,
        isDownloaded: false,
      },
    ]);
    expect(
      (await (await trackedRoute.GET(request('/api/tracked'))).json()).map(
        (t: { title: string }) => t.title,
      ),
    ).toEqual([normal.title]);
    expect(updatesFeed()).toMatchObject({ trackedCount: 0, autoCount: 0 });
    expect(listTracked()).toHaveLength(2);
    expect(listTracked().find((t) => t.id === followed.id)?.autoDownload).toBe(true);
    expect(
      (db().prepare('SELECT COUNT(*) AS n FROM observed_chapters').get() as { n: number }).n,
    ).toBe(1);
    updateSettings({ adultContent: true });
    expect(await (await trackedRoute.GET(request('/api/tracked'))).json()).toHaveLength(2);
    expect(updatesFeed()).toMatchObject({ trackedCount: 1, autoCount: 1 });
  });
  it('keeps a safe followed work visible when all its sources are NSFW', async () => {
    recordSourceFlags([nsfw]);
    track({
      media: normal,
      sources: [{ sourceId: nsfw.id, sourceName: nsfw.name, suwayomiMangaId: 10 }],
    });
    expect(listTracked()[0].media.adult).toBe(false);
    expect(await (await trackedRoute.GET(request('/api/tracked'))).json()).toHaveLength(1);
    expect((await discover({})).items.some((m) => m.id === normal.id)).toBe(true);
  });
});
describe('adult visibility on catalog surfaces', () => {
  it('filters discovery and keeps cache namespaces independent of adult mode', async () => {
    expect((await discover({})).items.map((m) => m.id)).toEqual(['anilist:1']);
    updateSettings({ adultContent: true });
    expect((await discover({})).items).toHaveLength(2);
    expect(requests.filter((r) => r.url.includes('anilist'))).toHaveLength(2);
  });
  it('filters full/quick search, local catalog and provider results; enabled mode restores all providers', async () => {
    recordSourceFlags([nsfw]);
    indexCatalog([
      {
        sourceId: nsfw.id,
        sourceName: nsfw.name,
        suwayomiMangaId: 88,
        mangaUrl: '/fixture',
        thumbnailUrl: null,
        lang: 'fr',
        title: 'Explicit local',
      },
    ]);
    const off = await search('Explicit', 'MANGA');
    expect(off.results.every((m) => !m.adult)).toBe(true);
    expect(off.results.some((m) => m.id.startsWith('suwayomi:'))).toBe(true);
    updateSettings({ adultContent: true });
    const on = await search('Explicit', 'MANGA');
    expect(on.results.some((m) => m.adult && m.id.startsWith('anilist:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('mangadex:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('mangaupdates:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('suwayomi:'))).toBe(true);
  });
  it('filters relations/recommendations at read time and always returns direct details', async () => {
    const off = await mediaDetail('anilist:1');
    expect(off.relations).toEqual([]);
    expect(off.recommendations.map((m) => m.id)).toEqual(['anilist:1']);
    expect(await mediaDetail('anilist:2')).toMatchObject({ adult: true, adultOverride: null });
    updateSettings({ adultContent: true });
    const on = await mediaDetail('anilist:1');
    expect(on.relations).toHaveLength(1);
    expect(on.recommendations).toHaveLength(2);
    expect((await mediaDetail('anilist:2')).adult).toBe(true);
    updateSettings({ adultContent: false });
    expect(await mediaDetail('anilist:2')).toMatchObject({ adult: true, adultOverride: null });
  });
  it('filters releases, planning and each home shelf and restores adult titles when enabled', async () => {
    seedReleases();
    saveMetadata('home:top:false', [normal, adult]);
    saveMetadata('home:top:true', [normal, adult]);
    expect(releasesPage({}).items).toHaveLength(1);
    expect(planning({ week: '2026-10-15' }).days.flatMap((d) => d.items)).toHaveLength(1);
    let home = await homeFeed();
    expect(home.hero).toHaveLength(1);
    expect(home.top).toHaveLength(1);
    expect(home.latest.manga).toHaveLength(1);
    updateSettings({ adultContent: true });
    expect(releasesPage({}).items).toHaveLength(2);
    expect(planning({ week: '2026-10-15' }).days.flatMap((d) => d.items)).toHaveLength(2);
    home = await homeFeed();
    expect(home.hero).toHaveLength(2);
    expect(home.top).toHaveLength(2);
    expect(home.latest.manga).toHaveLength(2);
    updateSettings({ adultContent: false });
    expect(releasesPage({}).items).toHaveLength(1);
    expect(planning({ week: '2026-10-15' }).days.flatMap((d) => d.items)).toHaveLength(1);
    home = await homeFeed();
    expect(home.hero).toHaveLength(1);
    expect(home.top).toHaveLength(1);
    expect(home.latest.manga).toHaveLength(1);
  });
  it('retains adult evidence across older safe metadata for the same series', () => {
    seedReleases();
    saveReleases([
      {
        id: 'mangadex:old-safe',
        media: { ...adult, adult: false },
        chapter: 2,
        volume: null,
        label: 'c.2',
        group: null,
        releasedAt: '2026-10-14T12:00:00Z',
        hasTime: true,
        provider: 'mangadex',
        trackedId: null,
      },
    ]);
    expect(releasesPage({}).items.every((r) => r.media.id !== adult.id)).toBe(true);
  });
  for (const enabled of [false, true]) {
    it(`keeps flagged sources browsable, searchable and matchable (filter preference ${enabled})`, async () => {
      updateSettings({ adultContent: enabled });
      expect((await sourceInfos()).find((s) => s.id === nsfw.id)?.nsfw).toBe(true);
      expect((await sources()).map((s) => s.id)).toEqual([safe.id, nsfw.id]);
      expect((await searchSource(nsfw, 'Fixture')).results).toHaveLength(1);
      expect(await matchOnSource(nsfw, { title: 'Fixture', altTitles: [] })).toHaveLength(1);
      expect((await browseSource(nsfw.id, { mode: 'POPULAR', page: 1 })).items).toHaveLength(1);
      const stream = await (await streamRoute.GET(request('/api/search/stream?q=Fixture'))).text();
      expect(stream).toContain(nsfw.id);
      const sync = await (
        await syncRoute.POST(request('/api/catalog/sync', { pages: 1 }, 'POST'))
      ).text();
      expect(sync).toContain(nsfw.id);
    });
  }
  it('filters locally classified source works and overrides, retaining unknown titles without lookup calls', async () => {
    const { setAdultOverride } = await import('@/lib/adult');
    saveMetadata('detail:local-mapping', { ...adult, title: 'Fixture' });
    expect((await searchSource(nsfw, 'Fixture')).results).toHaveLength(0);
    setAdultOverride({ ...adult, title: 'Fixture' }, adult.id, false);
    expect((await searchSource(nsfw, 'Fixture')).results).toHaveLength(1);
    setAdultOverride(emptyMedia('suwayomi:10', 'Fixture', 'MANGA'), 'suwayomi:10', true);
    expect(
      (await browseSource(nsfw.id, { mode: 'SEARCH', query: 'Fixture', page: 1 })).items,
    ).toHaveLength(0);
    updateSettings({ adultContent: true });
    expect((await searchSource(nsfw, 'Fixture')).results).toHaveLength(1);
  });
  it('reads Kavita X18Plus=14, propagates indexed adult status and hides local series', async () => {
    updateSettings({ kavitaUrl: 'http://kavita.invalid', kavitaApiKey: 'synthetic-key' });
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/Library/libraries'))
        return Response.json([{ id: 1, name: 'Manga', type: 0, folders: [] }]);
      if (url.includes('/Series/all-v2'))
        return Response.json([{ id: 9, libraryId: 1, name: 'X rated' }]);
      if (url.includes('/Series/metadata')) return Response.json({ ageRating: 14, genres: [] });
      if (url.includes('/Series/volumes')) return Response.json([]);
      throw new Error('Unexpected Kavita request');
    });
    await syncKavitaIndex();
    expect(kavitaMedia(9).adult).toBe(true);
    expect(kavitaSummaries()).toEqual([]);
    expect(await mediaDetail('kavita:9')).toMatchObject({ adult: true, adultOverride: null });
    updateSettings({ adultContent: true });
    expect(kavitaSummaries()).toHaveLength(1);
    expect((await mediaDetail('kavita:9')).adult).toBe(true);
  });
});

describe('manual adult decisions', () => {
  async function patch(id: string, adult: boolean | null) {
    const response = await adultRoute.PATCH(request('/api/media/adult', { id, adult }, 'PATCH'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json();
  }
  for (const enabled of [false, true]) {
    for (const automatic of [false, true]) {
      it(`marks, unmarks and resets every warm surface (18+ ${enabled}, automatic ${automatic})`, async () => {
        updateSettings({ adultContent: enabled });
        const target = automatic ? adult : normal;
        track({ media: target });
        seedReleases();
        for (const item of [normal, adult])
          saveMetadata(`hero:artwork:v1:${item.id}`, {
            ...item,
            bannerUrl: 'https://s4.anilist.co/banner.jpg',
          });
        saveMetadata('home:top:false', [normal, adult]);
        saveMetadata('home:top:true', [normal, adult]);
        saveMetadata('detail:anilist:99', {
          ...normal,
          id: 'anilist:99',
          anilistId: 99,
          title: 'Parent',
          tags: [],
          relations: [{ relation: 'SEQUEL', media: target }],
          recommendations: [target],
        });
        const assertSurfaces = async (override: boolean | null) => {
          const effective = override ?? automatic;
          const visible = enabled || !effective;
          const check = (items: (typeof normal)[]) => {
            const found = items.find((m) => m.id === target.id);
            expect(Boolean(found)).toBe(visible);
            if (found) expect(found).toMatchObject({ adult: effective, adultOverride: override });
          };
          check((await discover({})).items as (typeof normal)[]);
          // The header and full search share this endpoint.
          const searched = await (
            await import('@/app/api/search/route')
          ).GET(request('/api/search?q=Story&type=MANGA'));
          expect(searched.status).toBe(200);
          check((await searched.json()).results);
          check(releasesPage({}).items.map((r) => r.media) as (typeof normal)[]);
          check(
            planning({ week: '2026-10-15' }).days.flatMap((d) =>
              d.items.map((r) => r.media),
            ) as (typeof normal)[],
          );
          const home = await homeFeed();
          check(home.hero.map((r) => r.media) as (typeof normal)[]);
          check(home.top as (typeof normal)[]);
          check(home.latest.manga.map((r) => r.media) as (typeof normal)[]);
          const parent = await mediaDetail('anilist:99');
          check(parent.relations.map((r) => r.media) as (typeof normal)[]);
          check(parent.recommendations as (typeof normal)[]);
          const library = await (await trackedRoute.GET(request('/api/tracked'))).json();
          check(library.map((t: { media: typeof normal }) => t.media));
          expect(libraryActivity().hiddenAdult).toBe(visible ? 0 : 1);
          const detail = await detailRoute.GET(request(`/api/media?id=${target.id}`));
          expect(detail.status).toBe(200);
          expect(await detail.json()).toMatchObject({ adult: effective, adultOverride: override });
        };
        await assertSurfaces(null);
        for (const value of [true, false, null, false, true, null]) {
          expect(await patch(target.id, value)).toEqual({
            id: target.id,
            adult: value ?? automatic,
            adultOverride: value,
          });
          await assertSurfaces(value);
        }
        expect(
          JSON.parse(
            (db().prepare('SELECT media_json FROM tracked_media').get() as { media_json: string })
              .media_json,
          ).adult,
        ).toBe(automatic);
      });
    }
  }

  it('matches and resets all catalog, tracked, source and Kavita identities', async () => {
    const dex = 'b24f2bc0-415f-4a22-92c2-d5cd3a2a4401';
    const media = { ...normal, mangadexId: dex, mangaUpdatesId: '98765432109876543210' };
    const followed = track({
      media,
      kavitaSeriesId: 9,
      sources: [{ sourceId: '9223372036854775806', sourceName: 'Fixture', suwayomiMangaId: 44 }],
    });
    saveMetadata(`detail:mangadex:${dex}`, {
      ...media,
      tags: [],
      relations: [],
      recommendations: [],
    });
    await discover({});
    updateSettings({ adultContent: true });
    await discover({});
    updateSettings({ adultContent: false });
    vi.stubGlobal('fetch', async () => {
      throw new Error('All providers offline');
    });
    const { adultResolver } = await import('@/lib/adult');
    const ids = [
      media.id,
      `mangadex:${dex}`,
      `mangaupdates:${media.mangaUpdatesId}`,
      'suwayomi:44',
      'kavita:9',
    ];
    for (const origin of ids) {
      for (const value of [true, false, null]) {
        const response = await patch(origin, value);
        expect(response).toMatchObject({ adult: value ?? false, adultOverride: value });
        expect((await discover({})).items.some((m) => m.id === normal.id)).toBe(value !== true);
        expect(await (await trackedRoute.GET(request('/api/tracked'))).json()).toHaveLength(
          value === true ? 0 : 1,
        );
        const resolve = adultResolver();
        for (const id of ids)
          expect(resolve(emptyMedia(id, 'Unrelated display title', 'MANGA'))).toEqual({
            adult: value ?? false,
            adultOverride: value,
          });
        expect(
          resolve({ ...emptyMedia('local:fixture', 'Other', 'MANGA'), trackedId: followed.id }),
        ).toEqual({ adult: value ?? false, adultOverride: value });
      }
    }
    expect(db().prepare('SELECT * FROM adult_overrides').all()).toEqual([]);
    expect(listTracked()[0].media.adultOverride).toBe(null);
  });

  it('learns later provider aliases, resolves conflicting decisions by last edit, and resets after rehydration', async () => {
    const { adultResolver } = await import('@/lib/adult');
    await patch('anilist:1', true);
    await patch('anilist:2', false);
    const dex = 'b24f2bc0-415f-4a22-92c2-d5cd3a2a4401';
    saveMetadata('detail:bridge', { ...adult, mangadexId: dex, mangaUpdatesId: '123' });
    expect(adultResolver()(emptyMedia(`mangadex:${dex}`, 'Alias', 'MANGA'))).toEqual({
      adult: false,
      adultOverride: false,
    });
    saveMetadata('detail:second-bridge', { ...normal, mangadexId: dex });
    expect(adultResolver()(normal).adultOverride).toBe(false);
    // A second SQLite connection sees the durable decision and invalidates warmed snapshots.
    const Database = (await import('better-sqlite3')).default;
    const external = new Database(path.join(directory, 'users', '1', 'bunko.db'));
    external
      .prepare('UPDATE adult_overrides SET adult=1,revision=revision+10 WHERE identity=?')
      .run('anilist:1');
    external.close();
    expect(adultResolver()(adult).adultOverride).toBe(true);
    await patch('anilist:1', null);
    expect(adultResolver()(adult)).toEqual({ adult: true, adultOverride: null });
  });

  it('supports uncatalogued provider-only details and never stores an override as automatic evidence', async () => {
    for (const provider of ['mangaupdates', 'suwayomi', 'kavita']) {
      const id = `${provider}:7`;
      const raw = { ...emptyMedia(id, `${provider} work`, 'MANGA'), adult: true };
      const cacheKey = id.startsWith('suwayomi:') ? null : `detail:${id}`;
      if (cacheKey)
        saveMetadata(cacheKey, { ...raw, tags: [], relations: [], recommendations: [] });
      // Followed offline media is enough to edit: no provider availability required.
      const followed = track({ media: raw });
      expect(await patch(id, false)).toEqual({ id, adult: false, adultOverride: false });
      expect(listTracked().find((t) => t.id === followed.id)?.media.adult).toBe(false);
      expect(await patch(id, null)).toEqual({ id, adult: true, adultOverride: null });
    }
  });

  it('keeps automatic classification when tracking a manually classified response, then resets through an alias after untracking', async () => {
    for (const automatic of [false, true]) {
      const id = automatic ? adult.id : normal.id;
      await patch(id, !automatic);
      const response = await mediaDetail(id);
      const added = await trackedRoute.POST(request('/api/tracked', { media: response }, 'POST'));
      expect(added.status).toBe(201);
      const followed = await added.json();
      expect(
        JSON.parse(
          (
            db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(followed.id) as {
              media_json: string;
            }
          ).media_json,
        ).adult,
      ).toBe(automatic);
      await patch(id, null);
      expect(listTracked().find((t) => t.id === followed.id)?.media.adult).toBe(automatic);
      untrack(followed.id);
    }
    const followed = track({
      media: normal,
      sources: [{ sourceId: '123', sourceName: 'Fixture', suwayomiMangaId: 55 }],
    });
    await patch(normal.id, true);
    untrack(followed.id);
    await patch(normal.id, null);
    const { adultResolver } = await import('@/lib/adult');
    expect(adultResolver()(emptyMedia('suwayomi:55', 'Source', 'MANGA'))).toEqual({
      adult: false,
      adultOverride: null,
    });
  });

  it('validates each provider ID and boolean/null bodies before mutation, with auth and origin protection', async () => {
    const invalid = [
      'anilist:x',
      'anilist:0',
      'anilist:-1',
      'anilist:2147483648',
      'anilist:01',
      'mangadex:' + '-'.repeat(36),
      'mangaupdates:abc',
      'mangaupdates:123456789012345678901',
      'suwayomi:1:2',
      'kavita:0',
      'local:12',
      'anilist:1/../2',
      ' anilist:1',
    ];
    for (const id of invalid) {
      const response = await adultRoute.PATCH(
        request('/api/media/adult', { id, adult: true }, 'PATCH'),
      );
      expect(response.status, id).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of [
      { id: 'anilist:1' },
      { id: 'anilist:1', adult: 'true' },
      { id: 'anilist:1', adult: 1 },
      { adult: false },
    ])
      expect((await adultRoute.PATCH(request('/api/media/adult', body, 'PATCH'))).status).toBe(400);
    expect(
      (
        await adultRoute.PATCH(
          new Request('http://bunko.invalid/api/media/adult', { method: 'PATCH' }),
        )
      ).status,
    ).toBe(401);
    const cross = request('/api/media/adult', { id: 'anilist:1', adult: true }, 'PATCH');
    cross.headers.set('Origin', 'https://other.invalid');
    expect((await adultRoute.PATCH(cross)).status).toBe(403);
    expect(db().prepare('SELECT * FROM adult_overrides').all()).toEqual([]);
  });
});
