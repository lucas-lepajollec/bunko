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
// Listed with a poster in a catalog of its own category; its sheet has no poster nor category.
const listedOnly = meta('fixture-5', { poster: 'https://images.example/card-5.jpg' });
// Listed, but its sheet no longer answers.
const gone = meta('fixture-6');

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
      behaviorHints: { adult: true },
      catalogs: [
        {
          type: 'extvideo',
          id: 'fixtures',
          name: 'Fixture Catalog',
          category: 'scenes',
          categoryName: 'Scenes',
          extra: [{ name: 'search' }, { name: 'skip' }],
        },
        {
          type: 'extvideo',
          id: 'other-fixtures',
          name: 'Other Catalog',
          category: 'clips',
          categoryName: 'Clips',
        },
      ],
    });
  // A general extension: one section of its own, one catalog joining the anime kind.
  if (url.pathname === '/plain/manifest.json')
    return send({
      name: 'Plain Extension',
      resources: ['stream'],
      types: ['extvideo'],
      catalogs: [
        {
          type: 'extvideo',
          id: 'shorts',
          name: 'Shorts',
          category: 'shorts',
          categoryName: 'Shorts',
        },
        { type: 'extvideo', id: 'toons', name: 'Toons', category: 'anime' },
      ],
    });
  if (url.pathname.startsWith('/plain/catalog/extvideo/shorts'))
    return send({ metas: [meta('short-1')] });
  if (url.pathname.startsWith('/plain/catalog/extvideo/toons'))
    return send({ metas: [meta('toon-1')] });
  if (url.pathname.startsWith('/fixture/catalog/extvideo/other-fixtures'))
    return send({ metas: [listedOnly, gone] });
  if (url.pathname === '/fixture/meta/extvideo/fixture-5.json')
    return send({ meta: { id: 'fixture-5', name: listedOnly.name, type: 'movie' } });
  if (url.pathname === '/fixture/meta/extvideo/fixture-6.json') {
    res.writeHead(502);
    return res.end();
  }
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
    const page = await catalog.extensionCatalogPage({ section: 'scenes' }, {}, 1);
    expect(page.items).toEqual([]);
    expect(calls.some((call) => call.includes('/catalog/'))).toBe(false);
  }));

it('maps generic extvideo catalogs, excludes works already known, and stays in memory', async () =>
  inTenant(1, async () => {
    updateSettings({ adultContent: true, adultMode: true });
    const page = await catalog.extensionCatalogPage({ section: 'scenes' }, {}, 1);
    // Any external identity (AniList or TMDB) belongs to the native catalog: left out.
    expect(page.items.map((item) => item.title)).toEqual([
      'Fixture Video fixture-2',
      'Fixture Video fixture-4',
    ]);
    for (const item of page.items) {
      expect(item).toMatchObject({
        type: 'ANIME',
        format: null,
        kindOverride: 'extension',
        extensionSection: { id: 'scenes', name: 'Scenes' },
        providers: ['extension'],
        adult: true,
      });
      expect(item.id).toMatch(/^ext:[0-9a-f]{12}:[A-Za-z0-9_-]+$/);
    }
    const search = await catalog.extensionSearch('fixture', { section: 'scenes' });
    expect(search.map((item) => item.title)).toEqual(['Fixture Video fixture-2']);

    const known = page.items.find((item) => item.title.includes('fixture-2'))!;
    const detail = await catalog.extensionDetail(known.id);
    expect(detail).toMatchObject({
      title: 'Fixture Video fixture-2',
      adult: true,
      kindOverride: 'extension',
      extensionSection: { id: 'scenes', name: 'Scenes' },
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
    const page = await catalog.extensionCatalogPage({ section: 'scenes' }, {}, 1);
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

it('keeps what the catalog card showed when the extension sheet is poorer or gone', async () =>
  inTenant(1, async () => {
    updateSettings({ adultContent: true, adultMode: true });
    const page = await catalog.extensionCatalogPage({ section: 'clips' }, {}, 1);
    const [poor, missing] = ['fixture-5', 'fixture-6'].map((id) =>
      page.items.find((item) => item.title.endsWith(id))!,
    );
    expect(poor.coverUrl).toBe('https://images.example/card-5.jpg');
    // The sheet has no poster and no category: the card's poster and kind stay.
    expect(await catalog.extensionDetail(poor.id)).toMatchObject({
      coverUrl: 'https://images.example/card-5.jpg',
      bannerUrl: 'https://images.example/fixture-5-wide.jpg',
      extensionSection: { id: 'clips', name: 'Clips' },
    });
    // The sheet fails: the work still opens as listed.
    expect(await catalog.extensionDetail(missing.id)).toMatchObject({
      title: 'Fixture Video fixture-6',
      coverUrl: 'https://images.example/fixture-6.jpg',
      extensionSection: { id: 'clips', name: 'Clips' },
      extension: { type: 'movie' },
    });
  }));

it('drops extension catalog works from every list once the account leaves the 18+ only mode', async () =>
  inTenant(1, async () => {
    const { saveContinue, continueItems } = await import('@/lib/continue');
    const { visibleTracked } = await import('@/lib/adult');
    const { listTracked } = await import('@/lib/db');
    updateSettings({ adultContent: true, adultMode: true });
    const page = await catalog.extensionCatalogPage({ section: 'scenes' }, {}, 1);
    const work = page.items[0];
    saveContinue({
      media: {
        id: work.id,
        title: work.title,
        coverUrl: work.coverUrl,
        type: 'ANIME',
        format: null,
        origin: null,
        adult: true,
        color: null,
        kindOverride: 'extension',
        extensionSection: work.extensionSection,
      },
      kind: 'watch',
      label: 'Film',
      href: '/title/ext/fixture',
      position: 0.4,
    });
    track({ media: work, status: 'READING' });
    const ids = () => continueItems().map((item) => item.media.id);
    const followed = () => visibleTracked(listTracked()).map((t) => t.media.id);
    expect(ids()).toContain(work.id);
    expect(followed()).toContain(work.id);
    // 18+ next to everything else: ordinary 18+ works stay, extension catalog works do not.
    updateSettings({ adultMode: false });
    expect(ids()).not.toContain(work.id);
    expect(followed()).not.toContain(work.id);
    expect(followed()).toContain('anilist:42');
    updateSettings({ adultContent: false });
    expect(ids()).not.toContain(work.id);
  }));

it('reads the sections extensions declare, and general extensions outside 18+ only', async () =>
  inTenant(1, async () => {
    const { visibleExtensionSections } = await import('@/lib/extension-catalog-state');
    const { extensionCatalogAddons } = await import('@/lib/video-addons');
    updateSettings({
      videoAddons: [`${base}/fixture/manifest.json`, `${base}/plain/manifest.json`],
      adultContent: true,
      adultMode: true,
    });
    await extensionCatalogAddons();
    // Names come from the extensions; adult ones only in the full 18+ mode, the others outside.
    expect(visibleExtensionSections(true).map((s) => s.name)).toEqual(['Scenes', 'Clips']);
    expect(visibleExtensionSections(false).map((s) => s.name)).toEqual(['Shorts']);
    expect(
      (await catalog.extensionCatalogPage({ section: null }, {}, 1)).items.map((i) => i.title),
    ).not.toContain('Fixture Video short-1');

    updateSettings({ adultMode: false });
    const shorts = await catalog.extensionCatalogPage({ section: null }, {}, 1);
    expect(shorts.items.map((i) => [i.title, i.adult, i.extensionSection?.name])).toEqual([
      ['Fixture Video short-1', false, 'Shorts'],
    ]);
    // A catalog naming one of Bunko's kinds joins it instead of forming a section.
    const anime = await catalog.extensionCatalogPage({ native: 'anime' }, {}, 1);
    expect(anime.items.map((i) => [i.title, i.kindOverride, i.extensionSection])).toEqual([
      ['Fixture Video toon-1', 'anime', undefined],
    ]);
    // An adult extension's work does not open outside 18+ only.
    const adultWork = (await catalog.extensionSearch('fixture', { section: 'scenes' }))[0];
    expect(adultWork).toBeUndefined();
    updateSettings({ adultContent: false });
    expect((await catalog.extensionCatalogPage({ section: 'shorts' }, {}, 1)).items).toHaveLength(
      1,
    );
  }));
