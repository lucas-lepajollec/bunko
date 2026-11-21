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
    // A two-season work: season 2 lives elsewhere in Jellyfin.
    knownSeasons: (id: number) =>
      id === 50
        ? [1, 2].map((n) => ({
            number: n,
            anilistId: 49 + n,
            title: n === 1 ? 'Fixture Quest' : 'Fixture Quest: Second',
            year: 2023,
            status: 'FINISHED',
            episodes: 3,
            aired: 3,
            duration: 24,
            nextEpisode: null,
            list: [1, 2, 3].map((e) => ({ number: e, title: null, thumbnail: null })),
          }))
        : real.knownSeasons(id),
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
// Series C: films filed freely, Jellyfin could not number them ("unknown" episodes).
const unnumbered = [
  { Id: 'c3', SeriesId: 'C', Name: 'Chapter 3', PremiereDate: '2008-05-01', UserData: {} },
  {
    Id: 'c1',
    SeriesId: 'C',
    Name: 'Chapter 1',
    PremiereDate: '2007-12-01',
    UserData: { Played: true },
  },
  { Id: 'c2', SeriesId: 'C', Name: 'Chapter 2', PremiereDate: '2007-12-29', UserData: {} },
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
    return send({ Items: parent === 'L1' ? episodes : parent === 'L2' ? unnumbered : [] });
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

it('reads the named user only, never another account when the name is wrong', async () => {
  updateSettings({ jellyfinUser: 'other' });
  expect(await jellyfin.userId()).toBe('u1');
  updateSettings({ jellyfinUser: 'Typo' });
  await expect(jellyfin.userId()).rejects.toMatchObject({ code: 'JELLYFIN_USER_NOT_FOUND' });
  updateSettings({ jellyfinUser: '' });
  expect(await jellyfin.userId()).toBe('u2');
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

it('imports Jellyfin anime into the account that connected it only', async () => {
  const { accountsDb } = await import('@/lib/accounts-store');
  const { inTenant } = await import('@/lib/tenant-context');
  const { runTenantWorkers } = await import('@/lib/downloads');
  accountsDb()
    .prepare(
      `INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at)
      VALUES(2,'SecondAdmin','admin','h','e','2026-01-01')`,
    )
    .run();
  updateSettings({ autoImportJellyfin: true });
  await jellyfin.syncJellyfinIndex();
  expect(listTracked().length).toBeGreaterThan(0);
  await runTenantWorkers();
  inTenant(2, () => {
    expect(publicSettings().jellyfinUrl).toBe('');
    expect(listTracked()).toEqual([]);
    expect(jellyfin.jellyfinImportedIds()).toEqual([]);
  });
});

it('keeps episodes Jellyfin could not number, in release order, for links "in order"', async () => {
  const followed = track({ media: anime(5, 'Unrelated'), status: 'PLANNING' });
  await jellyfin.syncJellyfinIndex();
  const media = getTracked(followed.id)!.media;
  const presence = jellyfin.jellyfinPresence(media, {
    seriesId: 'C',
    season: 1,
    order: 'absolute',
  });
  expect(presence).toMatchObject({ ownedCount: 3, playedCount: 1, absolute: true });
  expect(presence!.bySeason[0].episodeIds).toEqual({ 1: 'c1', 2: 'c2', 3: 'c3' });
});

it('links episodes one by one, by hand, over any numbering', async () => {
  const followed = track({ media: anime(6, 'Picked By Hand'), status: 'PLANNING' });
  await jellyfin.syncJellyfinIndex();
  const media = getTracked(followed.id)!.media;
  // Episode 1 of the work is the third film, episode 2 the first, episode 3 has none.
  const presence = jellyfin.jellyfinPresence(media, {
    seriesId: 'C',
    season: 1,
    episodes: { '1': 'c3', '2': 'c1', '3': null, '4': 'missing-item' },
  });
  expect(presence).toMatchObject({ absolute: true, manual: true, ownedCount: 2, playedCount: 1 });
  expect(presence!.bySeason[0]).toMatchObject({
    owned: [1, 2],
    played: [2],
    episodeIds: { 1: 'c3', 2: 'c1' },
  });
  expect(jellyfin.jellyfinItems('C').map((i) => [i.id, i.n, i.name])).toEqual([
    ['c1', 1, 'Chapter 1'],
    ['c2', 2, 'Chapter 2'],
    ['c3', 3, 'Chapter 3'],
  ]);
});

it('lists what no work is linked to, ignores it, and makes it a work of its own', async () => {
  const { unlinkedItems, setUnlinkedIgnored, createSheet } = await import('@/lib/unlinked');
  track({ media: anime(1, 'Fixture Quest'), status: 'PLANNING' });
  await jellyfin.syncJellyfinIndex();
  const ids = () =>
    unlinkedItems()
      .filter((i) => i.integration === 'jellyfin' && !i.ignored)
      .map((i) => i.id)
      .sort();
  // A is linked to the followed work; the rest wait in the inbox.
  expect(ids()).not.toContain('A');
  expect(ids()).toContain('C');
  expect(unlinkedItems().find((i) => i.id === 'C')).toMatchObject({ kind: 'series', count: 3 });
  setUnlinkedIgnored('jellyfin', 'C', true);
  expect(ids()).not.toContain('C');
  expect(unlinkedItems().find((i) => i.id === 'C')?.ignored).toBe(true);
  setUnlinkedIgnored('jellyfin', 'C', false);
  const entry = createSheet({
    integration: 'jellyfin',
    id: 'C',
    kind: 'anime',
    title: 'Chapters Kept As Anime',
    year: 2007,
    section: null,
  });
  expect(entry).toMatchObject({ title: 'Chapters Kept As Anime', type: 'ANIME' });
  expect(entry.media).toMatchObject({ id: 'jellyfin:C', kindOverride: 'anime', year: 2007 });
  expect(entry.jellyfinLink).toMatchObject({ seriesId: 'C' });
  expect(ids()).not.toContain('C');
  // A reading kind cannot hold a video item; an extension kind needs its section.
  expect(() =>
    createSheet({
      integration: 'jellyfin',
      id: 'D',
      kind: 'manga',
      title: 'x',
      year: null,
      section: null,
    }),
  ).toThrow();
  expect(() =>
    createSheet({
      integration: 'jellyfin',
      id: 'D',
      kind: 'extension',
      title: 'x',
      year: null,
      section: null,
    }),
  ).toThrow();
  const extension = createSheet({
    integration: 'jellyfin',
    id: 'D',
    kind: 'extension',
    title: 'Mapped Show',
    year: null,
    section: { id: 'videos', name: 'Videos' },
  });
  expect(extension.media).toMatchObject({
    kindOverride: 'extension',
    extensionSection: { id: 'videos', name: 'Videos' },
  });
});

it('tells an Emby server from Jellyfin and links to its own web pages', async () => {
  expect(jellyfin.videoServerOf({ ProductName: 'Jellyfin Server', Version: '10.11.0' })).toBe(
    'jellyfin',
  );
  expect(jellyfin.videoServerOf({ Version: '10.8.13' })).toBe('jellyfin');
  expect(jellyfin.videoServerOf({ Version: '4.8.10.0' })).toBe('emby');
  expect(jellyfin.videoServerOf({ ProductName: 'Emby Server', Version: '4.9.1' })).toBe('emby');
  // The fixture is Jellyfin 10.11: Jellyfin links.
  await jellyfin.jellyfinInfo();
  expect(publicSettings().videoServer).toBe('jellyfin');
  expect(jellyfin.videoServerItemUrl('http://jf', 'abc')).toBe('http://jf/web/#/details?id=abc');
  db()
    .prepare("INSERT OR REPLACE INTO worker_state(key,value) VALUES('video_server','emby')")
    .run();
  db()
    .prepare("INSERT OR REPLACE INTO worker_state(key,value) VALUES('video_server_id','srv1')")
    .run();
  expect(publicSettings().videoServer).toBe('emby');
  expect(jellyfin.videoServerItemUrl('http://emby', 'abc')).toBe(
    'http://emby/web/index.html#!/item?id=abc&serverId=srv1',
  );
});

it('takes each season of a work from where it is in Jellyfin, chosen by hand or found', async () => {
  const work = { ...anime(50, 'Fixture Quest'), anilistId: 50 };
  const followed = track({ media: work, status: 'PLANNING' });
  await jellyfin.syncJellyfinIndex();
  const media = getTracked(followed.id)!.media;
  // Season 2 by hand: the episodes of another series.
  const presence = jellyfin.jellyfinPresence(media, {
    seriesId: 'A',
    season: 1,
    seasons: { '2': { seriesId: 'C', season: 1 } },
  });
  expect(presence).toMatchObject({ absolute: true, manual: true, seriesIds: ['A', 'C'] });
  expect(presence!.bySeason[0].episodeIds).toEqual({
    1: 'a1e1',
    2: 'a1e2',
    3: 'a1e3',
    4: 'c1',
    5: 'c2',
    6: 'c3',
  });
  expect(presence!.bySeason[0].played).toEqual([1, 2, 4]);
  // The other series counts as linked: it leaves the unlinked inbox.
  const { unlinkedItems } = await import('@/lib/unlinked');
  const { setIntegrationLink } = await import('@/lib/integration-links');
  setIntegrationLink(followed.id, 'jellyfin', {
    seriesId: 'A',
    season: 1,
    seasons: { '2': { seriesId: 'C', season: 1 } },
  });
  expect(unlinkedItems().some((i) => i.id === 'C')).toBe(false);
  // Without a choice, both seasons of series A are its seasons 1 and 2 (plain mapping).
  const plain = jellyfin.jellyfinPresence(media, null);
  expect(plain?.absolute).toBeUndefined();
});

it('works presences out once per index, and again once episodes are marked', async () => {
  const work = track({ media: { ...anime(70, 'Kept Work'), anilistId: 70 }, status: 'READING' });
  await jellyfin.syncJellyfinIndex();
  const link = { seriesId: 'A', season: 1 } as const;
  const media = getTracked(work.id)!.media;
  const first = jellyfin.jellyfinPresence(media, link);
  // The library asks for every work on each pass: the same answer, not worked out again.
  expect(jellyfin.jellyfinPresences([{ media, jellyfinLink: link }])[0]).toBe(first);
  // Another link is another answer.
  expect(jellyfin.jellyfinPresence(media, null)).not.toBe(first);
  // Marking episodes changes what is played: the next answer is fresh.
  jellyfin.forgetJellyfinPresence();
  expect(jellyfin.jellyfinPresence(media, link)).not.toBe(first);
  expect(jellyfin.jellyfinPresence(media, link)).toEqual(first);
});

it('keeps every integration link in one table, one per work and integration', async () => {
  const { setIntegrationLink, integrationLinks } = await import('@/lib/integration-links');
  const work = track({ media: anime(60, 'Linked Twice'), status: 'PLANNING' });
  setIntegrationLink(work.id, 'jellyfin', { seriesId: 'A', season: 1 });
  setIntegrationLink(work.id, 'stash', 'g7');
  expect(getTracked(work.id)).toMatchObject({
    jellyfinLink: { seriesId: 'A', season: 1 },
    stashLink: 'g7',
  });
  setIntegrationLink(work.id, 'stash', null);
  expect(getTracked(work.id)!.stashLink).toBeUndefined();
  expect(integrationLinks(work.id).get(work.id)).toEqual({
    jellyfin: { seriesId: 'A', season: 1 },
  });
});
