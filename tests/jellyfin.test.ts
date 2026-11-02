import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-jellyfin-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
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
  if (url.pathname === '/Users/u2/Items') {
    if (url.searchParams.get('IncludeItemTypes') === 'Series')
      return send({
        Items: [
          { Id: 'A', Name: 'Fixture Quest', ProductionYear: 2023, ProviderIds: {} },
          { Id: 'B', Name: 'Plugin Show', ProductionYear: 2020, ProviderIds: { AniList: '777' } },
        ],
      });
    return send({ Items: episodes });
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
  expect(presence).toMatchObject({ seriesId: 'A', season: 1, owned: [1, 2, 3], played: [1, 2] });
  // Watched in Jellyfin moves progress forward and starts the show.
  expect(getTracked(followed.id)).toMatchObject({ status: 'READING', progress: { read: 2 } });
});

it('picks the season from AniList titles, the plugin id, and manual links', async () => {
  await jellyfin.syncJellyfinIndex();
  expect(jellyfin.jellyfinPresence(anime(2, 'Fixture Quest Season 2'))).toMatchObject({
    seriesId: 'A',
    season: 2,
    owned: [1, 2],
  });
  expect(jellyfin.jellyfinPresence(anime(777, 'Another Name'))).toMatchObject({ seriesId: 'B' });
  expect(jellyfin.jellyfinPresence(anime(3, 'Unknown'))).toBeNull();
  expect(
    jellyfin.jellyfinPresence(anime(3, 'Unknown'), { seriesId: 'A', season: 2 }),
  ).toMatchObject({
    season: 2,
    manual: true,
  });
  expect(jellyfin.jellyfinPresence(anime(1, 'Fixture Quest'), 'none')).toBeNull();
  expect(jellyfin.seasonOf('Show 3rd Season')).toEqual({ base: 'Show', season: 3 });
});

it('forgets everything from a previous server', async () => {
  await jellyfin.syncJellyfinIndex();
  expect(
    jellyfin
      .jellyfinSeriesList()
      .map((s) => s.id)
      .sort(),
  ).toEqual(['A', 'B']);
  updateSettings({ jellyfinUrl: 'http://other.invalid' });
  expect(jellyfin.jellyfinSeriesList()).toEqual([]);
  expect(listTracked()).toEqual([]);
});
