import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-extension-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const catalog = await import('@/lib/extension-catalog');

const calls: string[] = [];
const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Fixture Video ${id}`,
  poster: `https://images.example/${id}.jpg`,
  background: `https://images.example/${id}-wide.jpg`,
  description: 'A neutral fixture work.',
  genres: ['Fixture'],
  year: 2026,
  type: 'movie',
  ...extra,
});
const metas = [
  meta('fixture-1', { externalIds: { anilistId: 42 } }),
  meta('fixture-2'),
  meta('fixture-3', {
    type: 'series',
    externalIds: { tmdbId: 9001 },
    videos: [
      {
        id: 'fixture-3-1-1',
        season: 1,
        episode: 1,
        title: 'First',
        released: '2026-11-16T12:00:00Z',
      },
    ],
  }),
  // No external identity: the generic extension catalog owns it.
  meta('fixture-4', {
    type: 'series',
    videos: [
      {
        id: 'fixture-4-1-1',
        season: 1,
        episode: 1,
        title: 'First',
        released: '2026-11-16T12:00:00Z',
      },
      {
        id: 'fixture-4-1-2',
        season: 1,
        episode: 2,
        title: 'Second',
        released: '2026-11-17T12:00:00Z',
      },
    ],
  }),
];
const byId = new Map(metas.map((m) => [m.id, m]));

const server: Server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  calls.push(`${req.method} ${url.pathname}`);
  const send = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/fixture/manifest.json')
    return send({
      name: 'Fixture Extension',
      resources: ['stream'],
      types: ['extvideo', 'movie', 'series'],
      catalogs: [{ type: 'extvideo', id: 'fixtures', name: 'Fixture Catalog' }],
    });
  if (url.pathname.startsWith('/fixture/catalog/extvideo/fixtures')) {
    const search = url.pathname.includes('search=');
    return send({ metas: search ? [byId.get('fixture-2')] : metas });
  }
  if (url.pathname.startsWith('/fixture/meta/extvideo/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop()!.replace('.json', ''));
    return send({ meta: byId.get(id) ?? null });
  }
  if (url.pathname.startsWith('/fixture/stream/extvideo/'))
    return send({
      streams: [
        { name: 'Fixture Direct', title: 'VOSTFR 1080p', url: 'https://cdn.example/fixture.mp4' },
        {
          name: 'Fixture Proxy',
          title: 'VF 720p',
          url: `${base}/proxy/fixture.m3u8`,
          behaviorHints: { proxyHeaders: { request: { Referer: 'https://player.example/' } } },
        },
        { name: 'Fixture Torrent', title: 'VOSTFR', infoHash: 'fixture-hash' },
      ],
    });
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

// An existing AniList work: the extension meta that names it must not be duplicated.
track({
  media: {
    ...emptyMedia('anilist:42', 'Existing Fixture', 'ANIME'),
    anilistId: 42,
  },
  status: 'READING',
});

it('does not read extension catalogs outside the full 18+ mode', async () =>
  inTenant(1, async () => {
    updateSettings({
      videoAddons: [`${base}/fixture/manifest.json`],
      adultContent: true,
      adultMode: false,
    });
    calls.length = 0;
    const page = await catalog.extensionCatalogPage('tube', { kind: 'tube' }, 1);
    expect(page.items).toEqual([]);
    expect(calls.some((call) => call.includes('/catalog/'))).toBe(false);
  }));

it('maps generic extvideo catalogs, excludes works already known, and stays in memory', async () =>
  inTenant(1, async () => {
    updateSettings({ adultContent: true, adultMode: true });
    const page = await catalog.extensionCatalogPage('tube', { kind: 'tube' }, 1);
    // Any external identity (AniList or TMDB) belongs to the native catalog: left out.
    expect(page.items.map((item) => item.title)).toEqual([
      'Fixture Video fixture-2',
      'Fixture Video fixture-4',
    ]);
    for (const item of page.items) {
      expect(item).toMatchObject({
        type: 'ANIME',
        format: null,
        kindOverride: 'tube',
        providers: ['extension'],
        adult: true,
      });
      expect(item.id).toMatch(/^ext:[0-9a-f]{12}:[A-Za-z0-9_-]+$/);
    }
    const search = await catalog.extensionSearch('fixture');
    expect(search.map((item) => item.title)).toEqual(['Fixture Video fixture-2']);

    const known = page.items.find((item) => item.title.includes('fixture-2'))!;
    const detail = await catalog.extensionDetail(known.id);
    expect(detail).toMatchObject({
      title: 'Fixture Video fixture-2',
      adult: true,
      kindOverride: 'tube',
      extension: { type: 'movie' },
    });
    expect(detail.video?.list).toHaveLength(1);

    // No extension response is written to the SQLite metadata cache.
    const keys = (db().prepare('SELECT key FROM metadata_cache').all() as { key: string }[]).map(
      (row) => row.key,
    );
    expect(keys.some((key) => key.includes('extvideo') || key.startsWith('ext:'))).toBe(false);
  }));

it('plays extension streams through safe links and maps real release dates', async () =>
  inTenant(1, async () => {
    const page = await catalog.extensionCatalogPage('tube', { kind: 'tube' }, 1);
    const movie = page.items.find((item) => item.title.includes('fixture-2'))!;
    const streams = await catalog.extensionStreams(movie.id, 'fr');
    expect(streams.errors).toEqual([]);
    const direct = streams.streams.find((stream) => stream.name === 'Fixture Direct')!;
    expect(direct).toMatchObject({ kind: 'direct', version: 'sub', quality: 1080 });
    expect(direct.url).toBe('https://cdn.example/fixture.mp4');
    const proxied = streams.streams.find((stream) => stream.name === 'Fixture Proxy')!;
    expect(proxied.url).toBeNull();
    expect(proxied.relayUrl).toMatch(/^\/api\/video\/relay\/[\w-]+$/);
    expect(JSON.stringify(streams)).not.toContain(base);
    expect(streams.streams.find((stream) => stream.name === 'Fixture Torrent')?.kind).toBe(
      'torrent',
    );

    const releases = await catalog.extensionReleases(
      new Date('2026-11-10T00:00:00Z'),
      new Date('2026-11-20T00:00:00Z'),
    );
    expect(releases.map((release) => [release.label, release.releasedAt])).toEqual([
      ['Ep. 2', '2026-11-17T12:00:00.000Z'],
      ['Ep. 1', '2026-11-16T12:00:00.000Z'],
    ]);
    expect(releases.every((release) => release.provider === 'extension')).toBe(true);
  }));
