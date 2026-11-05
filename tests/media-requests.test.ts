import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
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
const { db } = await import('@/lib/db');
const { updateSettings } = await import('@/lib/settings');
const requests = await import('@/lib/media-requests');

// A tiny Sonarr, Radarr, Prowlarr and qBittorrent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { service: string; method: string; path: string; query: URLSearchParams; body: any };
const calls: Call[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const added: { service: string; body: Record<string, any> }[] = [];
let queue: Record<string, unknown>[] = [];
let torrentList: Record<string, unknown>[] = [];
const release = (title: string) => ({
  guid: `guid-${title}`,
  indexerId: 3,
  title,
  indexer: 'Nyaa',
  size: 2 * 1024 ** 3,
  seeders: 40,
  leechers: 2,
  protocol: 'torrent',
  rejected: true,
  rejections: [{ reason: 'Episode is not monitored' }],
  quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
  languages: [{ name: 'Japanese' }],
  fullSeason: true,
});
const serve = (service: string) =>
  createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (body: unknown, type = 'application/json') => {
      res.writeHead(200, { 'Content-Type': type, 'Set-Cookie': 'SID=fixture; HttpOnly' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const p = url.pathname;
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : raw;
      calls.push({ service, method: req.method!, path: p, query: url.searchParams, body });
      if (service === 'qbittorrent') {
        if (p === '/api/v2/auth/login') return send('Ok.', 'text/plain');
        const bearer = req.headers.authorization;
        if (bearer ? bearer !== 'Bearer qbt_fixture' : req.headers.cookie !== 'SID=fixture')
          return (res.writeHead(403), res.end());
        if (p === '/api/v2/torrents/info') return send(torrentList);
        if (p === '/api/v2/app/version') return send('v5.0.0', 'text/plain');
      }
      if (p === '/api/v3/qualityprofile') return send([{ id: 4, name: 'HD-1080p' }]);
      if (p === '/api/v3/rootfolder') return send([{ path: `/${service}`, freeSpace: 5e11 }]);
      if (p === '/api/v3/queue') return send({ records: queue });
      if (req.method === 'POST' && (p === '/api/v3/series' || p === '/api/v3/movie')) {
        added.push({ service, body });
        return send({
          id: 1,
          seasons: [
            { seasonNumber: 0, statistics: { episodeFileCount: 0, totalEpisodeCount: 2 } },
            { seasonNumber: 1, statistics: { episodeFileCount: 0, totalEpisodeCount: 12 } },
          ],
        });
      }
      if (p === '/api/v3/series')
        return send(
          added.some((a) => a.service === 'sonarr')
            ? [
                {
                  id: 1,
                  monitored: false,
                  seasons: [
                    { seasonNumber: 1, statistics: { episodeFileCount: 0, totalEpisodeCount: 12 } },
                  ],
                },
              ]
            : [],
        );
      if (p === '/api/v3/movie')
        return send(
          added.some((a) => a.service === 'radarr')
            ? [{ id: 2, hasFile: false, monitored: false }]
            : [],
        );
      if (p === '/api/v3/series/lookup') return send([{ title: 'Lookup', tvdbId: 81797 }]);
      if (p === '/api/v3/movie/lookup/tmdb') return send({ title: 'Lookup', tmdbId: 129 });
      if (p === '/api/v3/release' && req.method === 'GET')
        return send([release('Show S01 1080p VOSTFR')]);
      if (p === '/api/v1/search' && req.method === 'GET')
        return send([release('Show.S01.MULTI.2160p.x265')]);
      if (req.method === 'POST' && (p === '/api/v3/release' || p === '/api/v1/search'))
        return send({});
      res.writeHead(404);
      res.end();
    });
  });
const names = ['sonarr', 'radarr', 'prowlarr', 'qbittorrent'] as const;
const servers = names.map(serve);
await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
const base = (i: number) =>
  `http://127.0.0.1:${(servers[i].address() as import('node:net').AddressInfo).port}`;

beforeEach(() => {
  calls.length = 0;
  added.length = 0;
  queue = [];
  torrentList = [];
  db().exec('DELETE FROM media_grabs');
  updateSettings({
    sonarrUrl: base(0),
    sonarrApiKey: 'k',
    radarrUrl: base(1),
    radarrApiKey: 'k',
    prowlarrUrl: base(2),
    prowlarrApiKey: 'k',
    qbittorrentUrl: base(3),
    qbittorrentUsername: 'admin',
    qbittorrentPassword: 'secret',
    qbittorrentApiKey: '',
    sonarrRootFolder: '/tv',
    sonarrAnimeRootFolder: '/anime',
  });
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(folder, { recursive: true, force: true });
});

it('prepares an anime in Sonarr without monitoring or searching anything', async () => {
  const target = await requests.prepareSearch('anilist:21');
  expect(added[0].body).toMatchObject({
    tvdbId: 81797,
    seriesType: 'anime',
    rootFolderPath: '/anime',
    monitored: false,
    addOptions: { monitor: 'none', searchForMissingEpisodes: false },
  });
  expect(target.seasons.map((s) => s.number)).toEqual([1, 0]);
  expect(calls.some((c) => c.path === '/api/v3/command')).toBe(false);
  // Preparing again does not add twice.
  await requests.prepareSearch('anilist:21');
  expect(added).toHaveLength(1);
});

it('runs the interactive search of a season and of a film, and sends the chosen release', async () => {
  await requests.prepareSearch('anilist:21');
  const [r] = await requests.interactiveSearch('anilist:21', 1);
  const search = calls.find((c) => c.path === '/api/v3/release' && c.method === 'GET')!;
  expect(search.query.get('seriesId')).toBe('1');
  expect(search.query.get('seasonNumber')).toBe('1');
  expect(r).toMatchObject({
    service: 'sonarr',
    quality: 'WEBDL-1080p',
    resolution: '1080P',
    languages: ['VOSTFR', 'Japanese'],
    rejected: true,
    rejections: ['Episode is not monitored'],
    fullSeason: true,
  });
  await requests.grab({
    mediaId: 'anilist:21',
    title: 'Show',
    coverUrl: null,
    service: 'sonarr',
    guid: r.guid,
    indexerId: r.indexerId,
    releaseTitle: r.title,
    size: r.size,
  });
  expect(calls.find((c) => c.method === 'POST' && c.path === '/api/v3/release')!.body).toEqual({
    guid: r.guid,
    indexerId: 3,
  });
  await requests.prepareSearch('anilist:199');
  expect(added[1]).toMatchObject({ service: 'radarr', body: { tmdbId: 129, monitored: false } });
  expect((await requests.interactiveSearch('anilist:199', null))[0].service).toBe('radarr');
});

it('searches Prowlarr by name in the right categories', async () => {
  const [r] = await requests.prowlarrSearch('Show S01', 'tv');
  const call = calls.find((c) => c.service === 'prowlarr')!;
  expect(call.query.get('query')).toBe('Show S01');
  expect(call.query.getAll('categories')).toEqual(['5000', '5070']);
  expect(r).toMatchObject({ service: 'prowlarr', languages: ['MULTI', 'Japanese'], codec: 'HEVC' });
});

it('follows what was sent through the Sonarr queue and qBittorrent', async () => {
  for (const [service, title] of [
    ['sonarr', 'Show S01 1080p VOSTFR'],
    ['prowlarr', 'Show.S01.MULTI.2160p.x265'],
    ['prowlarr', 'Old.Release'],
  ] as const)
    await requests.grab({
      mediaId: 'anilist:21',
      title: 'Show',
      coverUrl: null,
      service,
      guid: title,
      indexerId: 3,
      releaseTitle: title,
      size: 100,
    });
  db().prepare("UPDATE media_grabs SET created_at=0 WHERE release_title='Old.Release'").run();
  queue = [
    {
      title: 'Show S01 1080p VOSTFR',
      size: 100,
      sizeleft: 40,
      status: 'downloading',
      timeleft: '00:02:30',
    },
  ];
  torrentList = [
    {
      hash: 'a',
      name: 'Show.S01.MULTI.2160p.x265',
      size: 100,
      progress: 1,
      dlspeed: 0,
      eta: 8640000,
      state: 'stalledUP',
    },
  ];
  const grabs = await requests.mediaGrabs();
  expect(grabs).toHaveLength(3);
  const byTitle = Object.fromEntries(grabs.map((g) => [g.releaseTitle, g]));
  expect(byTitle['Show S01 1080p VOSTFR']).toMatchObject({
    state: 'downloading',
    progress: 0.6,
    eta: 150,
  });
  expect(byTitle['Show.S01.MULTI.2160p.x265']).toMatchObject({ state: 'completed', progress: 1 });
  expect(byTitle['Old.Release']).toMatchObject({ state: 'gone' });
  requests.hideGrab(byTitle['Old.Release'].id);
  expect((await requests.mediaGrabs()).map((g) => g.releaseTitle)).not.toContain('Old.Release');
});

it('says when a work has no identity or the service is not set up', async () => {
  expect(await requests.mediaRequestState('anilist:999')).toMatchObject({
    state: 'unsupported',
    prowlarr: true,
  });
  updateSettings({ radarrUrl: '' });
  expect(await requests.mediaRequestState('tmdbmovie:603')).toMatchObject({
    state: 'unconfigured',
  });
});

it('uses a qBittorrent API key instead of logging in', async () => {
  const { qbittorrentVersion } = await import('@/lib/qbittorrent');
  updateSettings({ qbittorrentApiKey: 'qbt_fixture' });
  expect(await qbittorrentVersion()).toBe('v5.0.0');
  expect(calls.some((c) => c.path === '/api/v2/auth/login')).toBe(false);
  updateSettings({ qbittorrentApiKey: 'qbt_wrong' });
  await expect(qbittorrentVersion()).rejects.toMatchObject({ code: 'QBITTORRENT_UNAUTHORIZED' });
});
