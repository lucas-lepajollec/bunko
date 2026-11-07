import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-video-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
// The fixture servers run on loopback: allowed explicitly, as an administrator would.
process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { updateSettings } = await import('@/lib/settings');
const { seedAnimeIds, compact } = await import('@/lib/anime-ids');
const addons = await import('@/lib/video-addons');
const relay = await import('@/lib/video-relay');
const play = await import('@/lib/jellyfin-play');
const { publicSettings } = await import('@/lib/settings');
const { db } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');

const ITEM = 'a'.repeat(32);
const calls: string[] = [];
const server: Server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // A self-hosted addon on the local network that knows films and series by IMDb or TMDB id.
  if (url.pathname === '/local/manifest.json')
    return send({
      name: 'Local Streams',
      resources: ['stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt', 'tmdb:'],
    });
  // An aggregating addon that takes ~9 s to answer (many sources behind it).
  if (url.pathname === '/local/stream/movie/tt0000777.json') {
    setTimeout(
      () =>
        send({
          streams: [{ name: 'Slow', title: 'VOSTFR 1080p', url: 'https://cdn.example/slow.mp4' }],
        }),
      9000,
    );
    return;
  }
  if (url.pathname.startsWith('/local/stream/'))
    return send({
      streams: [
        {
          name: '🎬 1080p\nSource',
          title: '🏠 Proxy · 🇯🇵 VO\n🇫🇷 2 ST FR',
          url: `${base}/local/proxy/ep.m3u8`,
        },
        {
          name: '📺 720p\nSource',
          title: '🚀 Direct · 🇫🇷 VF\n🇫🇷 2 ST FR',
          url: 'https://cdn.example/vf.mp4',
        },
        {
          name: '📺 720p\nSource',
          title: '🚀 Direct · 💬 VOSTFR',
          url: 'https://cdn.example/st.mp4',
        },
      ],
    });
  // A Kitsu-based anime addon; its configured address holds an account key.
  if (url.pathname === '/addon/k3y-private/manifest.json')
    return send({
      name: 'Fixture Streams',
      resources: [
        { name: 'stream', types: ['anime', 'series'], idPrefixes: ['kitsu'] },
        { name: 'subtitles', types: ['anime', 'series'], idPrefixes: ['kitsu'] },
      ],
      types: ['anime', 'series'],
    });
  if (url.pathname === '/addon/k3y-private/stream/anime/kitsu:77:3.json')
    return send({
      streams: [
        { name: 'EN', title: 'English sub 1080p', url: 'https://cdn.example/ep3.mp4' },
        { name: 'M', title: 'MULTI VFF 2160p x265', url: 'https://cdn.example/ep3-4k.mkv' },
        { name: 'FR', title: 'VOSTFR 1080p', url: 'https://cdn.example/ep3.m3u8' },
        { name: 'T', title: 'VOSTFR torrent', infoHash: 'abc' },
        {
          name: 'H',
          title: 'VF 720p',
          url: `${base}/hls/master.m3u8`,
          behaviorHints: {
            proxyHeaders: { request: { Referer: 'https://player.example/', Host: 'x' } },
          },
        },
        { name: 'bad', url: 42 },
      ],
    });
  if (url.pathname === '/addon/k3y-private/subtitles/anime/kitsu:77:3.json')
    return send({
      subtitles: [
        { id: '1', url: `${base}/subs/fr.srt`, lang: 'fre' },
        { id: '2', url: `${base}/subs/ep.ass`, lang: 'eng' },
        { id: '3', url: 'ftp://nope', lang: 'eng' },
      ],
    });
  // Files behind the relay: the playlist checks the header the addon asked for.
  if (url.pathname.startsWith('/hls/')) {
    if (req.headers.referer !== 'https://player.example/') {
      res.writeHead(403);
      return res.end();
    }
    if (url.pathname === '/hls/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/fr.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n',
      );
    }
    if (url.pathname === '/hls/low/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
      return res.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXTINF:6,\nseg0.ts\n#EXTINF:6,\nhttps://cdn2.example/seg1.ts\n',
      );
    }
    if (url.pathname === '/hls/file.mp4') {
      const range = req.headers.range;
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' } : {}),
      });
      return res.end(range ? '2345' : '0123456789');
    }
  }
  if (url.pathname === '/subs/fr.srt') {
    res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
    // Latin-1, as many subtitle sites still serve.
    return res.end(
      Buffer.from('1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}Déjà vu\r\n', 'latin1'),
    );
  }
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
  if (req.method === 'POST' && url.pathname === `/Items/${ITEM}/PlaybackInfo`)
    return send({
      PlaySessionId: 'c'.repeat(32),
      MediaSources: [
        {
          Id: 'b'.repeat(32),
          Container: 'mkv',
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          TranscodingUrl: `/videos/${ITEM}/master.m3u8?MediaSourceId=x&ApiKey=secret-key&VideoBitrate=19800000`,
          DefaultAudioStreamIndex: 1,
          MediaStreams: [
            { Type: 'Video', Index: 0, Height: 1080 },
            { Type: 'Audio', Index: 1, Language: 'jpn', DisplayTitle: 'Japanese', IsDefault: true },
            { Type: 'Audio', Index: 2, Language: 'fre', DisplayTitle: 'French' },
            {
              Type: 'Subtitle',
              Index: 3,
              Codec: 'ass',
              DisplayTitle: 'French',
              DeliveryMethod: 'External',
              DeliveryUrl: `/Videos/${ITEM}/${'b'.repeat(32)}/Subtitles/3/0/Stream.vtt?ApiKey=secret-key`,
            },
            {
              Type: 'Subtitle',
              Index: 4,
              Codec: 'PGSSUB',
              DisplayTitle: 'PGS',
              DeliveryMethod: 'Encode',
            },
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

const ADDON = () => `${base}/addon/k3y-private/manifest.json`;

it('asks video extensions with the id they know, VOSTFR first, then VF', async () => {
  seedAnimeIds(compact([{ anilist_id: 5, type: 'TV', kitsu_id: 77, imdb_id: ['tt5'] }]));
  updateSettings({ videoAddons: [ADDON()] });
  expect(await addons.videoAddons()).toEqual([
    expect.objectContaining({
      name: 'Fixture Streams',
      host: new URL(base).host,
      resources: ['stream', 'subtitles'],
      error: null,
    }),
  ]);
  const result = await addons.episodeStreams(5, 3, 'fr');
  expect(result.errors).toEqual([]);
  expect(result.streams.map((s) => [s.name, s.kind, s.version, s.quality, s.webReady])).toEqual([
    ['FR', 'hls', 'sub', 1080, true],
    ['T', 'torrent', 'sub', null, true],
    ['M', 'direct', 'multi', 2160, false],
    ['H', 'hls', 'dub', 720, true],
    // English sub, but French subtitles exist for the episode: VO + VOSTFR, may start alone.
    ['EN', 'direct', 'other', 1080, true],
  ]);
  // Everything here may start by itself except the torrent (not playable in a browser).
  expect(result.streams.filter((s) => !s.autoplay).map((s) => s.name)).toEqual(['T']);
  // A stream that needs headers only plays through Bunko; the others may load directly.
  const h = result.streams.find((s) => s.name === 'H')!;
  expect(h.url).toBeNull();
  expect(h.relayUrl).toMatch(/^\/api\/video\/relay\/[\w-]+$/);
  expect(result.streams[0].url).toBe('https://cdn.example/ep3.m3u8');
  expect(result.subtitles.map((s) => [s.lang, s.source])).toEqual([
    ['fr', 'Fixture Streams'],
    ['en', 'Fixture Streams'],
  ]);
  // The addon's address (and its key) never reaches the browser.
  expect(JSON.stringify(result)).not.toContain('k3y-private');
  expect(addons.episodeIds(5, 3).map((i) => i.id)).toEqual([
    'kitsu:77:3',
    'tt5:1:3',
    'anilist:5:3',
  ]);
  updateSettings({ videoAudio: 'dubbed' });
  const dubbed = await addons.episodeStreams(5, 3, 'fr');
  expect(dubbed.streams.map((s) => s.name)).toEqual(['H', 'M', 'FR', 'T', 'EN']);
  updateSettings({ videoAudio: 'original' });
});

it('asks TMDB-based addons by TMDB id and plays their local links through the relay', async () => {
  seedAnimeIds(
    compact([
      { anilist_id: 5, type: 'TV', kitsu_id: 77, imdb_id: ['tt5'] },
      {
        anilist_id: 6,
        type: 'TV',
        themoviedb_id: 900,
        season: { tvdb: 1, tmdb: 2 },
        imdb_id: 'tt6',
      },
      { anilist_id: 7, type: 'MOVIE', themoviedb_id: 901 },
      { anilist_id: 8, type: 'TV', themoviedb_id: 902 },
    ]),
  );
  const ids = (anilist: number, episode: number) =>
    addons.episodeIds(anilist, episode).map((i) => i.id);
  // The TMDB season of the map, before IMDb (whose season is TVDB's).
  expect(ids(6, 4)).toEqual(['tmdb:900:2:4', 'tt6:1:4', 'anilist:6:4']);
  expect(ids(7, 1)).toEqual(['tmdb:901', 'anilist:7:1']);
  // No TMDB season known: no guess.
  expect(ids(8, 1)).toEqual(['anilist:8:1']);
  // TMDB files every season as season 1 (The Apothecary Diaries): sources understand the
  // season people use, here the TVDB one.
  seedAnimeIds(
    compact([
      { anilist_id: 30, type: 'TV', themoviedb_id: 950, season: { tvdb: 1, tmdb: 1 } },
      { anilist_id: 31, type: 'TV', themoviedb_id: 950, season: { tvdb: 2, tmdb: 1 } },
      {
        anilist_id: 32,
        type: 'TV',
        themoviedb_id: 950,
        season: { tvdb: 3, tmdb: 1 },
        imdb_id: 'tt9',
      },
    ]),
  );
  expect(ids(32, 5)).toEqual(['tmdb:950:3:5', 'tt9:3:5', 'anilist:32:5']);
  expect(ids(30, 5)).toEqual(['tmdb:950:1:5', 'anilist:30:5']);
  seedAnimeIds(
    compact([
      { anilist_id: 5, type: 'TV', kitsu_id: 77, imdb_id: ['tt5'] },
      {
        anilist_id: 6,
        type: 'TV',
        themoviedb_id: 900,
        season: { tvdb: 1, tmdb: 2 },
        imdb_id: 'tt6',
      },
      { anilist_id: 7, type: 'MOVIE', themoviedb_id: 901 },
      { anilist_id: 8, type: 'TV', themoviedb_id: 902 },
    ]),
  );

  updateSettings({ videoAddons: [`${base}/local/manifest.json`] });
  calls.length = 0;
  const result = await addons.episodeStreams(6, 4, 'fr');
  expect(calls).toContain('GET /local/stream/series/tmdb:900:2:4.json');
  // "VO" then "2 French subtitle files": original audio, not a subtitled release.
  expect(result.streams.map((s) => [s.title.split('\n')[0], s.version])).toEqual([
    ['🚀 Direct · 💬 VOSTFR', 'sub'],
    ['🚀 Direct · 🇫🇷 VF', 'dub'],
    ['🏠 Proxy · 🇯🇵 VO', 'vo'],
  ]);
  // On the allowed local service: Bunko reaches it, the viewer's browser cannot.
  const local = result.streams.find((s) => s.version === 'vo')!;
  expect(local.url).toBeNull();
  expect(local.relayUrl).toMatch(/^\/api\/video\/relay\/[\w-]+$/);
  expect(result.streams.find((s) => s.version === 'dub')!.url).toBe('https://cdn.example/vf.mp4');

  // A series known only by its TMDB id.
  calls.length = 0;
  await addons.titleStreams({ imdb: null, tmdb: 1399 }, { season: 1, episode: 2 }, 'fr');
  expect(calls).toContain('GET /local/stream/series/tmdb:1399:1:2.json');
  // A film known by both: IMDb, the id most addons know.
  calls.length = 0;
  await addons.titleStreams({ imdb: 'tt0000009', tmdb: 9 }, null, 'fr');
  expect(calls).toContain('GET /local/stream/movie/tt0000009.json');
  updateSettings({ videoAddons: [ADDON()] });
});

it('keeps extension addresses on the server, encrypted', async () => {
  const id = publicSettings().videoAddons[0];
  expect(publicSettings().videoAddons).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/)]);
  const stored = db().prepare("SELECT value FROM settings WHERE key='videoAddons'").get() as {
    value: string;
  };
  expect(stored.value).not.toContain('k3y-private');
  expect(addons.normalizeAddonUrl('stremio://addon.example/abc/manifest.json')).toBe(
    'https://addon.example/abc/manifest.json',
  );
  expect(addons.normalizeAddonUrl('https://addon.example/abc/')).toBe(
    'https://addon.example/abc/manifest.json',
  );
  await expect(addons.addVideoAddon(`${base}/missing/manifest.json`)).rejects.toMatchObject({
    code: 'ADDON_UNREACHABLE',
  });
  // Adding the same addon twice keeps one.
  expect(await addons.addVideoAddon(ADDON())).toHaveLength(1);
  expect(await addons.removeVideoAddon(id)).toEqual([]);
  expect(await addons.addVideoAddon(ADDON())).toHaveLength(1);
});

it('relays a stream with the headers its addon asked for, playlists included', async () => {
  const get = (path: string, init?: RequestInit) =>
    relay.relay(path.split('/').pop()!, new Request(`http://bunko${path}`, init));
  const master = await get(
    relay.relayPath({
      url: `${base}/hls/master.m3u8`,
      headers: { Referer: 'https://player.example/' },
    }),
  );
  const text = await master.text();
  const lines = text.split('\n').filter(Boolean);
  expect(lines[0]).toBe('#EXTM3U');
  expect(lines[1]).toMatch(/URI="\/api\/video\/relay\/[\w-]+"/);
  expect(lines[3]).toMatch(/^\/api\/video\/relay\/[\w-]+$/);
  expect(text).not.toContain(base);
  // Native HLS players ask for a byte range of the playlist: it is still read whole and rewritten.
  const ranged = await get(
    relay.relayPath({
      url: `${base}/hls/master.m3u8`,
      headers: { Referer: 'https://player.example/' },
    }),
    { headers: { Range: 'bytes=0-' } },
  );
  expect(ranged.status).toBe(200);
  expect(ranged.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
  expect((await ranged.text()).match(/\/api\/video\/relay\//g)).toHaveLength(2);
  // The variant playlist, reached through its relay link, keeps the header.
  const variant = await (await get(lines[3])).text();
  const links = variant
    .split('\n')
    .filter((l) => l.startsWith('/api/') || l.includes('URI="/api/'));
  expect(links).toHaveLength(3);
  expect(relay.unseal(/URI="([^"]+)"/.exec(variant)![1].split('/').pop()!).url).toBe(
    `${base}/hls/key.bin`,
  );
  expect(relay.unseal(links[2].split('/').pop()!).url).toBe('https://cdn2.example/seg1.ts');
  // Seeking: byte ranges pass through.
  const file = await get(
    relay.relayPath({
      url: `${base}/hls/file.mp4`,
      headers: { Referer: 'https://player.example/' },
    }),
    {
      headers: { Range: 'bytes=2-5' },
    },
  );
  expect(file.status).toBe(206);
  expect(file.headers.get('content-range')).toBe('bytes 2-5/10');
  expect(await file.text()).toBe('2345');
  // Without the header the file host refuses: the relay reports it.
  await expect(get(relay.relayPath({ url: `${base}/hls/file.mp4` }))).rejects.toMatchObject({
    code: 'VIDEO_STREAM_ERROR',
  });
  // A link belongs to one account and expires.
  const token = relay.seal({ url: `${base}/hls/file.mp4` });
  expect(() => inTenant(2, () => relay.unseal(token))).toThrow(/Unknown stream/);
  expect(() => relay.unseal(token, Date.now() + 13 * 3600_000)).toThrow(/expired/);
  expect(() => relay.unseal('garbage')).toThrow(/Unknown stream/);
  expect(relay.safeHeaders({ Referer: 'a', Host: 'b', 'User-Agent': 'c', X: 'a\r\nb' })).toEqual({
    Referer: 'a',
    'User-Agent': 'c',
  });
});

it('turns SRT and ASS subtitles into WebVTT', async () => {
  const { subtitles } = await addons.episodeStreams(5, 3, 'fr');
  const vtt = await (
    await relay.subtitle(subtitles[0].url.split('/').pop()!, new Request('http://bunko/'))
  ).text();
  expect(vtt).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nDéjà vu\n');
  expect(
    relay.assToVtt(
      [
        '[Script Info]',
        'Title: x',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:05.20,0:00:07.00,Default,,0,0,0,,{\\i1}Second{\\i0}, line\\Nhere',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First <b>',
        'Dialogue: 0,0:00:01.00,0:00:09.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}',
      ].join('\n'),
    ),
  ).toBe(
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst &lt;b&gt;\n\n00:00:05.200 --> 00:00:07.000\nSecond, line\nhere\n',
  );
  expect(relay.toVtt('WEBVTT\n\nx')).toBe('WEBVTT\n\nx');
});

it('reads a Jellyfin episode for the player and reports where it stopped', async () => {
  updateSettings({ jellyfinUrl: base, jellyfinApiKey: 'jf-key', jellyfinUser: '' });
  const info = await play.playbackInfo(ITEM, { profile: {}, maxBitrate: 120_000_000 });
  // Jellyfin decides (here: transcode); its URL goes through Bunko without the API key.
  expect(info.playMethod).toBe('transcode');
  expect(info.playUrl).toMatch(/^\/api\/jellyfin\/stream\/videos\/a{32}\/master\.m3u8\?/);
  expect(info.playUrl).not.toMatch(/secret-key/i);
  expect(info.subtitles[0].url).not.toMatch(/secret-key/i);
  expect(info).toMatchObject({
    title: 'The Third',
    resumeMs: 600_000,
    startMs: 600_000,
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

it('remembers where an extension stream stopped, per account', async () => {
  const positions = await import('@/lib/video-positions');
  positions.saveVideoPosition('anilist:21:3', 612.4, 1420);
  expect(positions.videoPosition('anilist:21:3')).toBe(612.4);
  positions.saveVideoPosition('anilist:21:3', 700, 1420);
  expect(positions.videoPosition('anilist:21:3')).toBe(700);
  // Another account has its own places.
  expect(inTenant(2, () => positions.videoPosition('anilist:21:3'))).toBeNull();
  // Watched to the end: forgotten.
  positions.saveVideoPosition('anilist:21:3', null, null);
  expect(positions.videoPosition('anilist:21:3')).toBeNull();
});

it('waits for a slow aggregating extension instead of dropping it', async () => {
  updateSettings({ videoAddons: [`${base}/local/manifest.json`] });
  addons.resetAddonRest();
  const result = await addons.titleStreams({ imdb: 'tt0000777', tmdb: 777 }, null, 'fr');
  expect(result.errors).toEqual([]);
  expect(result.streams.map((s) => s.name)).toEqual(['Slow']);
  updateSettings({ videoAddons: [ADDON()] });
}, 30_000);
