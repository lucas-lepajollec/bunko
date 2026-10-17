import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixtures/release-providers.json';
import type { AniMedia } from '@/lib/media';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-adult-tests-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { db, track, listTracked, indexCatalog, observeChapters } = await import('@/lib/db');
const { emptyMedia, fromAniList, fromMangaDex, fromMangaUpdates } = await import('@/lib/media');
const { recordSourceFlags, mediaAdult } = await import('@/lib/adult');
const { getSettings, updateSettings, persistentSecret } = await import('@/lib/settings');
const { settingsPatch } = await import('@/lib/validation');
const { discover, mediaDetail } = await import('@/lib/catalog');
const { search } = await import('@/lib/search-engine');
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
  coverImage: { extraLarge: null },
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
    'DELETE FROM tracked_media;DELETE FROM settings;DELETE FROM chapter_releases;DELETE FROM source_flags;DELETE FROM metadata_cache;DELETE FROM worker_state;DELETE FROM catalog_fts;DELETE FROM catalog_keys;DELETE FROM kavita_series;',
  );
  db().prepare("INSERT INTO worker_state VALUES('release_refresh',?)").run(String(Date.now()));
  updateSettings({ suwayomiUrl: 'http://source.invalid', autoImportKavita: false });
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
afterEach(() => {
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
    expect(off.results.some((m) => m.id.startsWith('suwayomi:'))).toBe(false);
    updateSettings({ adultContent: true });
    const on = await search('Explicit', 'MANGA');
    expect(on.results.some((m) => m.adult && m.id.startsWith('anilist:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('mangadex:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('mangaupdates:'))).toBe(true);
    expect(on.results.some((m) => m.id.startsWith('suwayomi:'))).toBe(true);
  });
  it('filters relations/recommendations at read time and rejects direct hidden details', async () => {
    const off = await mediaDetail('anilist:1');
    expect(off.relations).toEqual([]);
    expect(off.recommendations.map((m) => m.id)).toEqual(['anilist:1']);
    await expect(mediaDetail('anilist:2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    updateSettings({ adultContent: true });
    const on = await mediaDetail('anilist:1');
    expect(on.relations).toHaveLength(1);
    expect(on.recommendations).toHaveLength(2);
    expect((await mediaDetail('anilist:2')).adult).toBe(true);
    updateSettings({ adultContent: false });
    await expect(mediaDetail('anilist:2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
  it('skips NSFW source search/matching, browse and popular sync while preserving source metadata', async () => {
    const infos = await sourceInfos();
    expect(infos.find((s) => s.id === nsfw.id)?.nsfw).toBe(true);
    expect((await sources()).map((s) => s.id)).toEqual([safe.id]);
    await expect(searchSource(nsfw, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(matchOnSource(nsfw, normal)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(browseSource(nsfw.id, { mode: 'POPULAR', page: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const stream = await (await streamRoute.GET(request('/api/search/stream?q=Fixture'))).text();
    expect(stream).not.toContain(nsfw.id);
    const sync = await (
      await syncRoute.POST(request('/api/catalog/sync', { pages: 1 }, 'POST'))
    ).text();
    expect(sync).not.toContain(nsfw.id);
    updateSettings({ adultContent: true });
    expect(await sources()).toHaveLength(2);
    expect((await searchSource(nsfw, 'x')).source.nsfw).toBe(true);
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
    await expect(mediaDetail('kavita:9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    updateSettings({ adultContent: true });
    expect(kavitaSummaries()).toHaveLength(1);
    expect((await mediaDetail('kavita:9')).adult).toBe(true);
  });
});
