import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-arr-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { seedAnimeIds, compact } = await import('@/lib/anime-ids');
seedAnimeIds(
  compact([
    { anilist_id: 21, type: 'TV', tvdb_id: 81797, season: { tvdb: 1 } },
    { anilist_id: 199, type: 'MOVIE', themoviedb_id: { movie: 129 } },
  ]),
);
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { updateSettings } = await import('@/lib/settings');
const requests = await import('@/lib/media-requests');

// A tiny Sonarr + Radarr: what was added, the queue, and the keys they were called with.
const added: { service: string; body: Record<string, unknown> }[] = [];
const commands: unknown[] = [];
let queue: { size: number; sizeleft: number }[] = [];
let keys = new Set<string>();
const serve = (service: 'sonarr' | 'radarr') =>
  createServer((req, res) => {
    keys.add(`${service}:${req.headers['x-api-key']}`);
    const url = new URL(req.url!, 'http://x');
    const send = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = url.pathname;
      if (p === '/api/v3/system/status') return send({ version: '4.0.0' });
      if (p === '/api/v3/qualityprofile') return send([{ id: 4, name: 'HD-1080p' }]);
      if (p === '/api/v3/rootfolder') return send([{ path: `/${service}`, freeSpace: 5e11 }]);
      if (p === '/api/v3/queue') return send({ records: queue });
      if (p === '/api/v3/command') return (commands.push(JSON.parse(raw)), send({}));
      if (req.method === 'POST' && (p === '/api/v3/series' || p === '/api/v3/movie'))
        return (added.push({ service, body: JSON.parse(raw) }), send({ id: 1 }));
      if (p === '/api/v3/series')
        return send(
          added.some(
            (a) =>
              a.service === 'sonarr' && a.body.tvdbId === Number(url.searchParams.get('tvdbId')),
          )
            ? [
                {
                  id: 1,
                  title: 'x',
                  monitored: true,
                  statistics: { episodeFileCount: 3, episodeCount: 10 },
                },
              ]
            : [],
        );
      if (p === '/api/v3/movie')
        return send(
          added.some(
            (a) =>
              a.service === 'radarr' && a.body.tmdbId === Number(url.searchParams.get('tmdbId')),
          )
            ? [{ id: 1, title: 'x', monitored: true, hasFile: false }]
            : [],
        );
      if (p === '/api/v3/series/lookup') {
        const tvdb = Number(url.searchParams.get('term')!.replace('tvdb:', ''));
        return send([{ title: 'Lookup', tvdbId: tvdb }]);
      }
      if (p === '/api/v3/movie/lookup/tmdb')
        return send({ title: 'Lookup', tmdbId: Number(url.searchParams.get('tmdbId')) });
      res.writeHead(404);
      res.end();
    });
  });
const servers: Server[] = [serve('sonarr'), serve('radarr')];
await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
const base = (s: Server) =>
  `http://127.0.0.1:${(s.address() as import('node:net').AddressInfo).port}`;

beforeEach(() => {
  added.length = 0;
  commands.length = 0;
  queue = [];
  keys = new Set();
  updateSettings({
    sonarrUrl: base(servers[0]),
    sonarrApiKey: 'sonarr-key',
    radarrUrl: base(servers[1]),
    radarrApiKey: 'radarr-key',
    sonarrRootFolder: '/tv',
    sonarrAnimeRootFolder: '/anime',
    sonarrQualityProfile: 0,
  });
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(folder, { recursive: true, force: true });
});

it('adds an anime to Sonarr as an anime series, in the anime folder, and follows it', async () => {
  expect(await requests.mediaRequestState('anilist:21')).toMatchObject({
    service: 'sonarr',
    state: 'absent',
  });
  const state = await requests.requestMedia('anilist:21');
  expect(added[0]).toMatchObject({
    service: 'sonarr',
    body: {
      tvdbId: 81797,
      seriesType: 'anime',
      rootFolderPath: '/anime',
      qualityProfileId: 4,
      addOptions: { monitor: 'all', searchForMissingEpisodes: true },
    },
  });
  expect(state).toMatchObject({ state: 'partial', files: 3, total: 10 });
  queue = [{ size: 100, sizeleft: 25 }];
  expect(await requests.mediaRequestState('anilist:21')).toMatchObject({
    state: 'downloading',
    progress: 0.75,
  });
  // Asking again searches again instead of adding twice.
  await requests.requestMedia('anilist:21');
  expect(added).toHaveLength(1);
  expect(commands).toEqual([{ name: 'SeriesSearch', seriesId: 1 }]);
  expect(keys).toEqual(new Set(['sonarr:sonarr-key']));
});

it('sends films, anime films included, to Radarr', async () => {
  await requests.requestMedia('tmdbmovie:603');
  await requests.requestMedia('anilist:199');
  expect(added.map((a) => [a.service, a.body.tmdbId, a.body.rootFolderPath])).toEqual([
    ['radarr', 603, '/radarr'],
    ['radarr', 129, '/radarr'],
  ]);
  expect(await requests.mediaRequestState('tmdbmovie:603')).toMatchObject({ state: 'wanted' });
});

it('says when a work has no identity or the service is not set up', async () => {
  expect(await requests.mediaRequestState('anilist:999')).toMatchObject({ state: 'unsupported' });
  updateSettings({ radarrUrl: '' });
  expect(await requests.mediaRequestState('tmdbmovie:603')).toMatchObject({
    state: 'unconfigured',
  });
  expect(await requests.arrOptions('sonarr')).toEqual({
    profiles: [{ id: 4, name: 'HD-1080p' }],
    folders: [{ path: '/sonarr', freeSpace: 5e11 }],
  });
});
