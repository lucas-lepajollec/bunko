import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-live-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { updateSettings, getSettings } = await import('@/lib/settings');
const { liveDb, closeLiveDb } = await import('@/lib/live/store');
const live = await import('@/lib/live/live');
const { xmltvTime } = await import('@/lib/live/guide');
const { parseM3u, cleanName } = await import('@/lib/live/playlist');
const { unseal } = await import('@/lib/video-relay');

const at = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};
const now = Date.now();
const channels = [
  {
    id: 'TF1.fr',
    name: 'TF1',
    alt_names: [],
    country: 'FR',
    categories: ['general'],
    is_nsfw: false,
  },
  {
    id: 'France24.fr',
    name: 'France 24',
    alt_names: [],
    country: 'FR',
    categories: ['news'],
    is_nsfw: false,
  },
  {
    id: 'Arte.fr',
    name: 'Arte',
    alt_names: ['ARTE'],
    country: 'FR',
    categories: ['culture'],
    is_nsfw: false,
  },
  {
    id: 'CanalPlus.fr',
    name: 'Canal+',
    alt_names: [],
    country: 'FR',
    categories: ['movies'],
    is_nsfw: false,
  },
  {
    id: 'Pirate.fr',
    name: 'Pirate',
    alt_names: [],
    country: 'FR',
    categories: ['sports'],
    is_nsfw: false,
  },
  {
    id: 'Closed.fr',
    name: 'Closed',
    alt_names: [],
    country: 'FR',
    categories: [],
    closed: '2020-01-01',
  },
  {
    id: 'Adult.fr',
    name: 'Adult',
    alt_names: [],
    country: 'FR',
    categories: ['xxx'],
    is_nsfw: true,
  },
  {
    id: 'BBCNews.uk',
    name: 'BBC News',
    alt_names: [],
    country: 'UK',
    categories: ['news'],
    is_nsfw: false,
  },
];
const streams = [
  { channel: 'France24.fr', url: 'https://cdn.example/f24.m3u8', quality: '720p' },
  {
    channel: 'France24.fr',
    feed: 'Arabic',
    url: 'https://cdn.example/f24-ar.m3u8',
    quality: '1080p',
  },
  {
    channel: 'France24.fr',
    feed: 'French',
    url: 'https://cdn.example/f24-hd.m3u8',
    quality: '1080p',
    referrer: 'https://www.france24.com/',
  },
  {
    channel: 'Arte.fr',
    url: 'https://cdn.example/arte.m3u8',
    quality: '1080p',
    labels: ['Geo-blocked'],
  },
  { channel: 'Pirate.fr', url: 'https://bad.example/x.m3u8' },
  { channel: 'Adult.fr', url: 'https://cdn.example/a.m3u8' },
  { channel: 'BBCNews.uk', url: 'javascript:alert(1)' },
];
const guide = `<?xml version="1.0"?><tv>
  <channel id="France24.fr"><display-name>France 24</display-name></channel>
  <channel id="C+.fr"><display-name>Canal+</display-name></channel>
  <channel id="Unknown.fr"><display-name>Nobody</display-name></channel>
  <programme start="${at(now - 1800_000)}" stop="${at(now + 1800_000)}" channel="France24.fr"><title lang="fr">Le Journal &amp; la météo</title><desc>Infos</desc><category>News</category></programme>
  <programme start="${at(now + 1800_000)}" stop="${at(now + 3600_000)}" channel="France24.fr"><title>Débat</title></programme>
  <programme start="${at(now - 600_000)}" stop="${at(now + 6000_000)}" channel="C+.fr"><title>Film</title><icon src="https://img.example/f.jpg"/></programme>
  <programme start="${at(now - 99 * 3600_000)}" stop="${at(now - 98 * 3600_000)}" channel="France24.fr"><title>Old</title></programme>
  <programme start="${at(now)}" stop="${at(now + 600_000)}" channel="Unknown.fr"><title>Lost</title></programme>
</tv>`;
const playlist = `#EXTM3U url-tvg="http://127.0.0.1:PORT/epg.xml?username=me&password=secret"
#EXTINF:-1 tvg-id="CanalPlus.fr" tvg-logo="https://logo.example/c.png" group-title="FR | Cinéma",FR: Canal+ HD
http://iptv.example/live/me/secret/101.ts
#EXTINF:-1 tvg-id="" group-title="FR",TF1 FHD
#EXTVLCOPT:http-user-agent=MyBox/1.0
http://iptv.example/live/me/secret/102.ts
#EXTINF:-1 group-title="Perso",Ma chaîne locale
https://local.example/stream.m3u8
#EXTINF:-1 group-title="VOD",Un film
http://iptv.example/movie/me/secret/9.mkv
`;
let requests: string[] = [];
const server: Server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  requests.push(url.pathname);
  const send = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/channels.json') return send(channels);
  if (url.pathname === '/api/streams.json') return send(streams);
  if (url.pathname === '/api/logos.json')
    return send([
      {
        channel: 'TF1.fr',
        feed: 'SD',
        width: 900,
        format: 'PNG',
        url: 'https://logo.example/tf1-sd.png',
      },
      {
        channel: 'TF1.fr',
        feed: null,
        width: 300,
        format: 'PNG',
        url: 'https://logo.example/tf1.png',
      },
    ]);
  if (url.pathname === '/api/feeds.json')
    return send([
      { channel: 'France24.fr', id: 'French', name: 'French', is_main: true, languages: ['fra'] },
      { channel: 'France24.fr', id: 'Arabic', name: 'Arabic', is_main: false, languages: ['ara'] },
    ]);
  if (url.pathname === '/api/countries.json')
    return send([
      { code: 'FR', name: 'France', flag: '🇫🇷' },
      { code: 'UK', name: 'United Kingdom', flag: '🇬🇧' },
    ]);
  if (url.pathname === '/api/blocklist.json')
    return send([
      { channel: 'Pirate.fr', reason: 'dmca' },
      { channel: 'Adult.fr', reason: 'nsfw' },
    ]);
  if (url.pathname === '/guide.xml.gz') {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    return void res.end(gzipSync(guide));
  }
  if (url.pathname === '/epg.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return void res.end('<tv></tv>');
  }
  if (url.pathname === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    return void res.end(playlist.replace('PORT', String(port)));
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
process.env.BUNKO_VIDEO_ALLOWED_HOSTS = `127.0.0.1:${port}`;
process.env.BUNKO_LIVE_INDEX_URL = `${base}/api`;

beforeEach(async () => {
  db().exec('DELETE FROM live_favorites; DELETE FROM live_playlist;');
  updateSettings({
    liveGuideUrls: [`${base}/guide.xml.gz`],
    livePlaylistUrl: '',
    liveCountries: [],
    adultContent: false,
  });
  requests = [];
  await live.refreshLiveNow();
});
afterAll(() => {
  server.close();
  closeLiveDb();
  rmSync(directory, { recursive: true, force: true });
});

it('builds the index without removed, closed or unsafe entries', () => {
  const rows = liveDb()
    .prepare('SELECT id, playable, logo, streams FROM live_channels ORDER BY id')
    .all() as {
    id: string;
    playable: number;
    logo: string | null;
    streams: string;
  }[];
  expect(rows.map((r) => r.id)).toEqual([
    'Adult.fr',
    'Arte.fr',
    'BBCNews.uk',
    'CanalPlus.fr',
    'France24.fr',
    'TF1.fr',
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(byId['TF1.fr'].logo).toBe('https://logo.example/tf1.png');
  expect(byId['BBCNews.uk'].playable).toBe(0);
  // Main feed first (best quality first), other languages last and named.
  expect(
    JSON.parse(byId['France24.fr'].streams).map((s: { q: string; f?: string }) => [s.q, s.f]),
  ).toEqual([
    ['1080p', undefined],
    ['720p', undefined],
    ['1080p', 'Arabic'],
  ]);
  expect(byId['CanalPlus.fr'].playable).toBe(0);
});

it('reads XMLTV guides and keeps only the useful window', () => {
  const rows = liveDb()
    .prepare('SELECT channel_id, title, image FROM live_programmes ORDER BY start')
    .all();
  expect(rows).toEqual([
    { channel_id: 'France24.fr', title: 'Le Journal & la météo', image: null },
    { channel_id: 'CanalPlus.fr', title: 'Film', image: 'https://img.example/f.jpg' },
    { channel_id: 'France24.fr', title: 'Débat', image: null },
  ]);
  expect(xmltvTime('20261105002500 +0100')).toBe(Date.UTC(2026, 10, 4, 23, 25));
});

it('home: playable channels of the country with what is on now, no 18+', async () => {
  const home = await live.liveHome('fr-FR,fr;q=0.9');
  expect(home.countries).toEqual(['FR']);
  expect(home.onNow.map((c) => [c.id, c.now?.title, c.next?.title])).toEqual([
    ['France24.fr', 'Le Journal & la météo', 'Débat'],
  ]);
  expect(live.homeCountries('en-GB')).toEqual(['UK']);
  const catalog = await live.liveCatalog({ page: 1 });
  expect(catalog.channels.map((c) => c.id)).toEqual(['France24.fr', 'Arte.fr']);
  const every = await live.liveCatalog({ page: 1, all: true });
  expect(every.channels.map((c) => c.id)).not.toContain('Adult.fr');
  expect(every.total).toBe(5);
  expect(
    (await live.liveCatalog({ page: 1, all: true, country: 'UK' })).channels.map((c) => c.id),
  ).toEqual(['BBCNews.uk']);
  expect(
    (await live.liveCatalog({ page: 1, all: true, q: 'canal' })).channels.map((c) => c.id),
  ).toEqual(['CanalPlus.fr']);
  expect((await live.liveCatalog({ page: 1, all: true, category: 'news' })).total).toBe(2);
  updateSettings({ adultContent: true, adultMode: true });
  expect((await live.liveCatalog({ page: 1, all: true })).channels.map((c) => c.id)).toEqual([
    'Adult.fr',
  ]);
});

it('channel: streams go through the relay with their headers, guide included', async () => {
  const channel = await live.liveChannel('France24.fr');
  expect(channel.now?.title).toBe('Le Journal & la météo');
  expect(channel.schedule.map((p) => p.title)).toEqual(['Le Journal & la météo', 'Débat']);
  expect(channel.streams.map((s) => s.label)).toEqual(['1080p', '720p', 'Arabic · 1080p']);
  const token = channel.streams[0].url.split('/').pop()!;
  expect(unseal(token)).toEqual({
    url: 'https://cdn.example/f24-hd.m3u8',
    headers: { Referer: 'https://www.france24.com/' },
  });
  await expect(live.liveChannel('Pirate.fr')).rejects.toMatchObject({ status: 404 });
  await expect(live.liveChannel('Adult.fr')).rejects.toMatchObject({ status: 404 });
});

it('the user’s playlist makes subscribed channels playable', async () => {
  updateSettings({ livePlaylistUrl: `${base}/playlist.m3u` });
  expect(getSettings().livePlaylistUrl).toContain('playlist.m3u');
  const home = await live.liveHome('fr-FR');
  expect(
    home.playlist.map((c) => [c.id.startsWith('m3u:') ? 'm3u' : c.id, c.fromPlaylist]),
  ).toEqual([
    ['CanalPlus.fr', true],
    ['TF1.fr', true],
    ['m3u', true],
  ]);
  expect(home.onNow.map((c) => c.id)).toContain('CanalPlus.fr');
  const canal = await live.liveChannel('CanalPlus.fr');
  expect(canal.playable).toBe(true);
  expect(unseal(canal.streams[0].url.split('/').pop()!).url).toBe(
    'http://iptv.example/live/me/secret/101.m3u8',
  );
  const tf1 = await live.liveChannel('TF1.fr');
  expect(unseal(tf1.streams[0].url.split('/').pop()!).headers).toEqual({
    'User-Agent': 'MyBox/1.0',
  });
  // The playlist's guide is fetched too, but never shown with its credentials.
  await live.refreshLiveNow();
  expect(requests).toContain('/epg.xml');
  const status = live.liveStatus();
  expect(JSON.stringify(status)).not.toContain('secret');
  expect(status.playlist).toMatchObject({ configured: true, entries: 3, matched: 2, error: null });
  const own = home.playlist.find((c) => c.id.startsWith('m3u:'))!;
  live.setFavorite(own.id, true);
  live.setFavorite('France24.fr', true);
  expect((await live.liveHome('fr-FR')).favorites.map((c) => c.name).sort()).toEqual([
    'France 24',
    'Ma chaîne locale',
  ]);
});

it('parses playlists and cleans channel names', () => {
  const { entries, guide: tvg } = parseM3u(playlist);
  expect(tvg).toContain('epg.xml');
  expect(entries.map((e) => e.name)).toEqual(['FR: Canal+ HD', 'TF1 FHD', 'Ma chaîne locale']);
  expect(cleanName('FR: Canal+ HD')).toEqual({ folded: 'canal+', country: 'FR' });
  expect(cleanName('|UK| BBC One FHD')).toEqual({ folded: 'bbcone', country: 'UK' });
});
