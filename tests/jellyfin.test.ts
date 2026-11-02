import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-jellyfin-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
// Catalog lookups: the plugin id 777 is a known work, title searches find nothing.
vi.mock('@/lib/anime-franchise', async (original) => {
  const real = await original<typeof import('@/lib/anime-franchise')>();
  const { emptyMedia } = await import('@/lib/media');
  return {
    ...real,
    prefetchNodes: async () => {},
    franchise: async (id: number) => ({
      root: { ...emptyMedia(`anilist:${id}`, 'Plugin Work', 'ANIME'), anilistId: id },
      seasons: [],
      index: { [id]: 1 },
    }),
  };
});
vi.mock('@/lib/search-engine', async (original) => ({
  ...(await original<typeof import('@/lib/search-engine')>()),
  search: async () => ({ results: [] }),
}));
const { seedAnimeIds, compact } = await import('@/lib/anime-ids');
// Offline id map: the TVDB show 900 is AniList 900.
seedAnimeIds(compact([{ anilist_id: 900, type: 'TV', tvdb_id: 900, season: { tvdb: 1 } }]));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, listTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, publicSettings } = await import('@/lib/settings');
const jellyfin = await import('@/lib/jellyfin');

const episodes = [
  // Series A, season 1: 1–3 owned, 1–2 watched; season 2: 1–2 owned.
  ...[1, 2, 3].map((n) => ({
    Id: `a1e${n}`,
    SeriesId: 'A',
    ParentIndexNumber: 1,
    IndexNumber: n,
    UserData: { Played: n <= 2 },
  })),
  ...[1, 2].map((n) => ({
    Id: `a2e${n}`,
    SeriesId: 'A',
    ParentIndexNumber: 2,
    IndexNumber: n,
    UserData: { Played: false },
  })),
  { Id: 'b1e1', SeriesId: 'B', ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true } },
];
let auth = '';
const server: Server = createServer((req, res) => {
  auth = String(req.headers['x-emby-token'] ?? '');
  const url = new URL(req.url!, 'http://x');
  const send = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/System/Info') return send({ Version: '10.11.0' });
  if (url.pathname === '/Users')
    return send([
      { Id: 'u1', Name: 'Other', Policy: { IsAdministrator: false } },
      { Id: 'u2', Name: 'Admin', Policy: { IsAdministrator: true } },
    ]);
  if (url.pathname === '/Library/VirtualFolders')
    return send([
      { Name: 'Anime', ItemId: 'L1', CollectionType: 'tvshows' },
      { Name: 'TV', ItemId: 'L2', CollectionType: 'tvshows' },
      { Name: 'Movies', ItemId: 'L3', CollectionType: 'movies' },
    ]);
  if (url.pathname === '/Users/u2/Items') {
    const parent = url.searchParams.get('ParentId');
    if (url.searchParams.get('IncludeItemTypes') === 'Series')
      return send({
        Items:
          parent === 'L1'
            ? [
                { Id: 'A', Name: 'Fixture Quest', ProductionYear: 2023, ProviderIds: {} },
                {
                  Id: 'D',
                  Name: 'Mapped Show',
                  ProductionYear: 2021,
                  ProviderIds: { Tvdb: '900' },
                },
                {
                  Id: 'B',
                  Name: 'Plugin Show',
                  ProductionYear: 2020,
                  ProviderIds: { AniList: '777' },
                },
              ]
            : parent === 'L2'
              ? [{ Id: 'C', Name: 'Office Drama', ProductionYear: 2005, ProviderIds: {} }]
              : [],
      });
    return send({ Items: parent === 'L1' ? episodes : [] });
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const anime = (id: number, title: string) => ({
  ...emptyMedia(`anilist:${id}`, title, 'ANIME'),
  anilistId: id,
});

beforeEach(() => {
  db().exec('DELETE FROM tracked_media; DELETE FROM jellyfin_series; DELETE FROM worker_state;');
  updateSettings({
    jellyfinUrl: base,
    jellyfinApiKey: 'jf-key',
    jellyfinUser: '',
    autoImportJellyfin: false,
    jellyfinLibraries: {},
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

it('keeps the key secret, indexes series and episodes, and reads watched state', async () => {
  expect(publicSettings()).not.toHaveProperty('jellyfinApiKey');
  const followed = track({ media: anime(1, 'Fixture Quest'), status: 'PLANNING' });
  await jellyfin.syncJellyfinIndex();
  expect(auth).toBe('jf-key');
  const presence = jellyfin.jellyfinPresence(getTracked(followed.id)!.media);
  expect(presence).toMatchObject({ seriesId: 'A', ownedCount: 5, playedCount: 2 });
  expect(presence!.bySeason[0]).toMatchObject({ season: 1, owned: [1, 2, 3], played: [1, 2] });
  expect(presence!.bySeason[1]).toMatchObject({ season: 2, owned: [1, 2], played: [] });
  // Watched in Jellyfin moves progress forward and starts the show.
  expect(getTracked(followed.id)).toMatchObject({ status: 'READING', progress: { read: 2 } });
});

it('finds the whole series from any season title, the plugin id, and manual links', async () => {
  await jellyfin.syncJellyfinIndex();
  expect(jellyfin.jellyfinPresence(anime(2, 'Fixture Quest Season 2'))).toMatchObject({
    seriesId: 'A',
  });
  expect(jellyfin.jellyfinPresence(anime(777, 'Another Name'))).toMatchObject({ seriesId: 'B' });
  expect(jellyfin.jellyfinPresence(anime(3, 'Unknown'))).toBeNull();
  expect(
    jellyfin.jellyfinPresence(anime(3, 'Unknown'), { seriesId: 'A', season: 1 }),
  ).toMatchObject({ seriesId: 'A', manual: true });
  expect(jellyfin.jellyfinPresence(anime(1, 'Fixture Quest'), 'none')).toBeNull();
  expect(jellyfin.seasonOf('Show 3rd Season')).toEqual({ base: 'Show', season: 3 });
});
it('counts watched episodes across the seasons of a work', () => {
  const presence = {
    seriesId: 'A',
    name: 'A',
    bySeason: [
      { season: 1, owned: [1, 2, 3], played: [1, 2, 3], episodeIds: {} },
      { season: 2, owned: [1, 2], played: [1], episodeIds: {} },
    ],
    ownedCount: 5,
    playedCount: 4,
    url: '',
    manual: false,
  };
  // Without catalog seasons, earlier Jellyfin seasons count what they hold.
  expect(jellyfin.watchedInWork(presence)).toBe(4);
  const season = (number: number, episodes: number) => ({
    number,
    anilistId: number,
    title: '',
    year: null,
    status: 'FINISHED',
    episodes,
    aired: episodes,
    duration: null,
    nextEpisode: null,
    list: [],
  });
  expect(jellyfin.watchedInWork(presence, [season(1, 12), season(2, 12)])).toBe(13);
});
it('follows every anime of the anime libraries, off-catalog when no clear match', async () => {
  updateSettings({ autoImportJellyfin: true });
  await jellyfin.syncJellyfinIndex();
  const tracked = listTracked();
  // Plugin id: the catalog work. No match: the Jellyfin series itself. TV library: a series.
  expect(tracked.find((t) => t.anilistId === 777)).toMatchObject({
    jellyfinLink: { seriesId: 'B' },
  });
  expect(tracked.find((t) => t.media.id === 'jellyfin:A')).toMatchObject({
    status: 'READING',
    progress: { read: 2 },
  });
  // The TV library's series is followed as a series (no TMDB key here: the Jellyfin item).
  expect(tracked.find((t) => t.title === 'Office Drama')?.media.format).toBe('SERIES');
  // TVDB id from Jellyfin: the work through the offline id map, no title search.
  expect(tracked.find((t) => t.anilistId === 900)).toMatchObject({
    jellyfinLink: { seriesId: 'D' },
  });
  // A removed work is not added again.
  const off = tracked.find((t) => t.media.id === 'jellyfin:A')!;
  db().prepare('DELETE FROM tracked_media WHERE id=?').run(off.id);
  await jellyfin.importJellyfinAnime();
  expect(listTracked().some((t) => t.media.id === 'jellyfin:A')).toBe(false);
});

it('forgets everything from a previous server', async () => {
  await jellyfin.syncJellyfinIndex();
  expect(
    jellyfin
      .jellyfinSeriesList()
      .map((s) => s.id)
      .sort(),
  ).toEqual(['A', 'B', 'C', 'D']);
  updateSettings({ jellyfinUrl: 'http://other.invalid' });
  expect(jellyfin.jellyfinSeriesList()).toEqual([]);
  expect(listTracked()).toEqual([]);
});
it('detects animated films libraries apart from films', () => {
  expect(jellyfin.detectRole('Films d’animation', 'movies')).toBe('animation');
  expect(jellyfin.detectRole('Films', 'movies')).toBe('movies');
  expect(jellyfin.detectRole('Anime', 'tvshows')).toBe('anime');
});
it('detects library roles and uses only anime libraries for anime', async () => {
  const libraries = await jellyfin.jellyfinLibraries();
  expect(libraries.map((l) => [l.name, l.role])).toEqual([
    ['Anime', 'anime'],
    ['TV', 'series'],
    ['Movies', 'movies'],
  ]);
  await jellyfin.syncJellyfinIndex();
  // A TV series with the same title is never taken for an anime.
  expect(jellyfin.jellyfinPresence(anime(9, 'Office Drama'))).toBeNull();
  updateSettings({ jellyfinLibraries: { L2: 'anime' } });
  await jellyfin.syncJellyfinIndex();
  expect(jellyfin.jellyfinPresence(anime(9, 'Office Drama'))).toMatchObject({ seriesId: 'C' });
});
it('shows import progress and disconnects, removing only what Jellyfin added', async () => {
  const mine = track({ media: anime(42, 'Hand Picked'), status: 'PLANNING' });
  updateSettings({ autoImportJellyfin: true });
  await jellyfin.syncJellyfinIndex();
  // Three anime-library series and one TV series, all handled in one pass.
  expect(jellyfin.jellyfinImportProgress()).toEqual({ done: 4, total: 4 });
  expect(jellyfin.jellyfinImportedIds()).toHaveLength(4);
  expect(jellyfin.disconnectJellyfin(true)).toEqual({ removed: 4 });
  expect(listTracked().map((t) => t.id)).toEqual([mine.id]);
  expect(publicSettings()).toMatchObject({ jellyfinUrl: '' });
  expect(jellyfin.jellyfinConfigured()).toBe(false);
});
