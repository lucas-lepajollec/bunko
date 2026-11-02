import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-video-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { updateSettings } = await import('@/lib/settings');
const { seedAnimeIds, compact } = await import('@/lib/anime-ids');
const addons = await import('@/lib/video-addons');
const play = await import('@/lib/jellyfin-play');

const ITEM = 'a'.repeat(32);
const calls: string[] = [];
const server: Server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // A Kitsu-based anime addon.
  if (url.pathname === '/addon/manifest.json')
    return send({
      name: 'Fixture Streams',
      resources: [{ name: 'stream', types: ['anime', 'series'], idPrefixes: ['kitsu'] }],
      types: ['anime', 'series'],
    });
  if (url.pathname === '/addon/stream/anime/kitsu:77:3.json')
    return send({
      streams: [
        { name: 'EN', title: 'English sub 1080p', url: 'https://cdn.example/ep3.mp4' },
        { name: 'FR', title: 'VOSTFR 1080p', url: 'https://cdn.example/ep3.m3u8' },
        { name: 'T', title: 'VOSTFR torrent', infoHash: 'abc' },
      ],
    });
  // Jellyfin.
  if (url.pathname === '/Users')
    return send([{ Id: 'u2', Name: 'Admin', Policy: { IsAdministrator: true } }]);
  if (url.pathname === `/Users/u2/Items/${ITEM}`)
    return send({
      Id: ITEM,
      Name: 'The Third',
      SeriesName: 'Fixture Show',
      ParentIndexNumber: 1,
      IndexNumber: 3,
      RunTimeTicks: 24 * 60 * 10_000_000,
      UserData: { PlaybackPositionTicks: 600 * 10_000_000, Played: false },
      MediaSources: [
        {
          Id: 'b'.repeat(32),
          MediaStreams: [
            { Type: 'Video', Index: 0, Height: 1080 },
            { Type: 'Audio', Index: 1, Language: 'jpn', DisplayTitle: 'Japanese', IsDefault: true },
            { Type: 'Audio', Index: 2, Language: 'fre', DisplayTitle: 'French' },
            { Type: 'Subtitle', Index: 3, Codec: 'ass', Language: 'fre', DisplayTitle: 'French' },
            { Type: 'Subtitle', Index: 4, Codec: 'PGSSUB', Language: 'eng', DisplayTitle: 'PGS' },
          ],
        },
      ],
    });
  if (req.method === 'POST' || req.method === 'DELETE') {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

it('asks video extensions with the id they know and puts the interface language first', async () => {
  seedAnimeIds(compact([{ anilist_id: 5, type: 'TV', kitsu_id: 77, imdb_id: ['tt5'] }]));
  updateSettings({ videoAddons: [`${base}/addon/manifest.json`] });
  expect(await addons.videoAddons()).toEqual([
    expect.objectContaining({ name: 'Fixture Streams', error: null }),
  ]);
  const { streams, errors } = await addons.episodeStreams(5, 3, 'fr');
  expect(errors).toEqual([]);
  expect(streams.map((s) => [s.name, s.kind, s.preferred])).toEqual([
    ['FR', 'hls', true],
    ['T', 'torrent', true],
    ['EN', 'direct', false],
  ]);
  expect(addons.episodeIds(5, 3).map((i) => i.id)).toEqual([
    'kitsu:77:3',
    'tt5:1:3',
    'anilist:5:3',
  ]);
});

it('reads a Jellyfin episode for the player and reports where it stopped', async () => {
  updateSettings({ jellyfinUrl: base, jellyfinApiKey: 'jf-key', jellyfinUser: '' });
  const info = await play.playbackInfo(ITEM);
  expect(info).toMatchObject({
    title: 'The Third',
    resumeMs: 600_000,
    durationMs: 1_440_000,
    height: 1080,
    audio: [
      { index: 1, label: 'Japanese', default: true },
      { index: 2, label: 'French', default: false },
    ],
    subtitles: [
      { index: 3, text: true },
      { index: 4, text: false },
    ],
  });
  calls.length = 0;
  await play.reportPlayback({
    itemId: ITEM,
    playSessionId: info.playSessionId,
    positionMs: 300_000,
    durationMs: 1_440_000,
    event: 'stop',
  });
  expect(calls.some((c) => c.startsWith(`POST /UserItems/${ITEM}/UserData`))).toBe(true);
  expect(calls.some((c) => c.startsWith('DELETE /Videos/ActiveEncodings'))).toBe(true);
  calls.length = 0;
  expect(
    await play.reportPlayback({
      itemId: ITEM,
      playSessionId: info.playSessionId,
      positionMs: 1_400_000,
      durationMs: 1_440_000,
      event: 'progress',
    }),
  ).toEqual({ finished: true });
  expect(calls.some((c) => c.startsWith(`POST /UserPlayedItems/${ITEM}`))).toBe(true);
});
