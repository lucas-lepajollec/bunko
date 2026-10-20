import type { DiscoverPage } from '@/types/shared';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-progressive-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const discovery = vi.hoisted(() => ({
  enabled: false,
  open: async (): Promise<DiscoverPage> => ({ items: [], page: 1, hasNextPage: false }),
  hard: async (): Promise<DiscoverPage> => ({ items: [], page: 1, hasNextPage: false }),
}));
vi.mock('@/lib/openlibrary', async (original) => ({
  ...(await original<object>()),
  discoverBooks: () => discovery.open(),
}));
vi.mock('@/lib/hardcover', async (original) => ({
  ...(await original<object>()),
  hardcoverConfigured: () => discovery.enabled,
  discoverHardcover: () => discovery.hard(),
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, closeTenant } = await import('@/lib/db');
const { updateSettings } = await import('@/lib/settings');
const { inTenant } = await import('@/lib/tenant-context');
const { revokeTenant } = await import('@/lib/tenant-lifecycle');
const { emptyMedia } = await import('@/lib/media');
const { cached, storedMetadata, metadataStatus } = await import('@/lib/metadata-cache');
const { withTracking, mediaDetail, progressiveDiscover } = await import('@/lib/catalog');
const { mediaPreview, rememberMediaPreview } = await import('@/lib/media-preview');
const { search } = await import('@/lib/search-engine');
const { chaptersFor } = await import('@/lib/suwayomi');
const { sourceServerKey } = await import('@/lib/source-server');
const work = () => ({ ...emptyMedia('anilist:301', 'Needle', 'MANGA'), anilistId: 301 });
const sources = [1, 2].map((id) => ({
  sourceId: String(id),
  sourceName: `Source ${id}`,
  suwayomiMangaId: id,
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const gates = new Map<string, ReturnType<typeof deferred>>();
const pendingKeys = new Set<string>();
let failDex = false;
let failChapter = false;
let chapterOffset = 0;
const discoverKeys = new Set<string>();
let requests: string[] = [];
const ani = (title = 'Needle') => ({
  id: 301,
  type: 'MANGA',
  format: 'MANGA',
  title: { english: title },
  genres: [],
  isAdult: false,
  coverImage: { large: null },
  relations: { edges: [] },
  recommendations: { nodes: [] },
  tags: [],
});
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM metadata_cache; DELETE FROM settings; DELETE FROM kavita_series; DELETE FROM reader_chapters',
  );
  updateSettings({ suwayomiUrl: 'http://source.fixture', autoImportKavita: false });
  gates.clear();
  pendingKeys.clear();
  requests = [];
  failDex = false;
  failChapter = false;
  chapterOffset = 0;
  discovery.enabled = false;
  discoverKeys.clear();
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}'));
    const lane =
      url.hostname === 'source.fixture' || url.hostname === 'new-source.fixture'
        ? `chapter:${body.variables.input.mangaId}`
        : url.hostname === 'graphql.anilist.co'
          ? body.query.includes('Media(id:')
            ? 'detail'
            : 'anilist'
          : url.hostname === 'api.mangadex.org'
            ? 'dex'
            : 'mu';
    requests.push(lane);
    await gates.get(lane)?.promise;
    if (lane === 'dex' && failDex) return new Response('{}', { status: 503 });
    if (lane === 'chapter:2' && failChapter) return new Response('{}', { status: 503 });
    if (lane.startsWith('chapter:')) {
      const number = body.variables.input.mangaId + chapterOffset;
      return Response.json({
        data: {
          fetchChapters: {
            chapters: [
              {
                id: 100 + number,
                name: `Ch. ${number}`,
                chapterNumber: number,
                isDownloaded: false,
                scanlator: null,
              },
            ],
          },
        },
      });
    }
    if (lane === 'detail') return Response.json({ data: { Media: ani('Enriched Needle') } });
    if (lane === 'anilist')
      return Response.json({
        data: { Page: { media: [ani()], pageInfo: { hasNextPage: false } } },
      });
    if (lane === 'dex') return Response.json({ data: [] });
    return Response.json({ results: [] });
  });
});
afterEach(async () => {
  for (const gate of gates.values()) gate.resolve();
  await vi.waitFor(() =>
    expect([...pendingKeys].some((key) => metadataStatus(key).pending)).toBe(false),
  );
  await vi.waitFor(() =>
    expect(
      [...discoverKeys].some((key) => storedMetadata<{ pending: boolean }>(key)?.value.pending),
    ).toBe(false),
  );
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
const watch = (key: string) => {
  pendingKeys.add(key);
  return key;
};

it.each(['manga', 'manhwa', 'manhua', 'lightnovel'] as const)(
  'returns a cold %s snapshot without holding an HTTP connection until AniList completes',
  async (kind) => {
    gates.set('anilist', deferred());
    const first = await progressiveDiscover({ kind });
    expect(first).toMatchObject({ pending: true, items: [] });
    expect(requests).toEqual(['anilist']);
    await progressiveDiscover({ kind });
    expect(requests).toEqual(['anilist']);
    gates.get('anilist')!.resolve();
    await vi.waitFor(async () => {
      expect(await progressiveDiscover({ kind })).toMatchObject({
        pending: false,
        items: [{ id: 'anilist:301' }],
      });
    });
  },
);

it('shows local search immediately, then each completed catalog while the last provider is still blocked', async () => {
  track({ media: work() });
  gates.set('anilist', deferred());
  gates.set('dex', deferred());
  gates.set('mu', deferred());
  for (const p of ['anilist', 'mangadex', 'mangaupdates']) watch(`search:${p}:false:MANGA:needle`);
  const first = await search('Needle', 'MANGA', undefined, false, true);
  expect(first.results.map((m) => m.id)).toEqual(['anilist:301']);
  expect(first.pending).toBe(true);
  gates.get('anilist')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus('search:anilist:false:MANGA:needle').pending).toBe(false),
  );
  const next = await search('Needle', 'MANGA', undefined, false, true);
  expect(next.results[0].id).toBe('anilist:301');
  expect(next.pending).toBe(true);
  failDex = true;
  gates.get('dex')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus('search:mangadex:false:MANGA:needle').pending).toBe(false),
  );
  const partial = await search('Needle', 'MANGA', undefined, false, true);
  expect(partial.providers.find((p) => p.provider === 'mangadex')?.status).toBe('error');
  expect(partial.results[0].id).toBe('anilist:301');
  gates.get('mu')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus('search:mangaupdates:false:MANGA:needle').pending).toBe(false),
  );
  expect((await search('Needle', 'MANGA', undefined, false, true)).pending).toBe(false);
});
it('does not wait for any catalog before showing the first remote result', async () => {
  gates.set('anilist', deferred());
  gates.set('dex', deferred());
  gates.set('mu', deferred());
  for (const p of ['anilist', 'mangadex', 'mangaupdates']) watch(`search:${p}:false:MANGA:needle`);
  expect((await search('Needle', 'MANGA', undefined, false, true)).results).toEqual([]);
  gates.get('anilist')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus('search:anilist:false:MANGA:needle').pending).toBe(false),
  );
  const next = await search('Needle', 'MANGA', undefined, false, true);
  expect(next.results.map((m) => m.id)).toEqual(['anilist:301']);
  expect(next.pending).toBe(true);
});
it('projects existing owned chapters immediately, then one source at a time without duplicate requests', async () => {
  const t = track({ media: work() });
  db()
    .prepare('INSERT INTO kavita_series(series_id,payload) VALUES(1,?)')
    .run(
      JSON.stringify({
        seriesId: 1,
        libraryId: 1,
        name: 'Needle',
        names: ['Needle'],
        folder: '/fixture',
        numbers: [9],
        volumes: [],
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=1 WHERE id=?').run(t.id);
  for (const id of [1, 2]) {
    gates.set(`chapter:${id}`, deferred());
    watch(`chapters:v1:${sourceServerKey()}:${id}:${id}`);
  }
  const controller = new AbortController();
  const first = await chaptersFor(sources, controller.signal, work(), undefined, true);
  expect(first.inKavita).toEqual([9]);
  expect(first.chapters.map((c) => c.number)).toEqual([9]);
  expect(first.pending).toBe(true);
  controller.abort(); // Closing the HTTP snapshot must not cancel its shared provider loads.
  gates.get('chapter:1')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus(`chapters:v1:${sourceServerKey()}:1:1`).pending).toBe(false),
  );
  const next = await chaptersFor(sources, undefined, work(), undefined, true);
  expect(next.chapters.map((c) => c.number)).toEqual([1, 9]);
  expect(next.pending).toBe(true);
  gates.get('chapter:2')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus(`chapters:v1:${sourceServerKey()}:2:2`).pending).toBe(false),
  );
  const last = await chaptersFor(sources, undefined, work(), undefined, true);
  expect(last.chapters.map((c) => c.number)).toEqual([1, 2, 9]);
  expect(last.pending).toBe(false);
  expect(requests.filter((r) => r.startsWith('chapter:'))).toHaveLength(2);
});
it('a complete worker refresh immediately replaces the interactive chapter cache', async () => {
  const key = watch(`chapters:v1:${sourceServerKey()}:1:1`);
  await chaptersFor([sources[0]], undefined, work(), undefined, true);
  await vi.waitFor(() => expect(metadataStatus(key).pending).toBe(false));
  chapterOffset = 10;
  expect((await chaptersFor([sources[0]], undefined, work())).chapters[0].number).toBe(11);
  expect(
    (await chaptersFor([sources[0]], undefined, work(), undefined, true)).chapters[0].number,
  ).toBe(11);
  expect(requests).toHaveLength(2);
});
it('keeps server namespaces separate when a progressive source load finishes after settings change', async () => {
  gates.set('chapter:1', deferred());
  const oldKey = watch(`chapters:v1:${sourceServerKey()}:1:1`);
  await chaptersFor([sources[0]], undefined, work(), undefined, true);
  await vi.waitFor(() => expect(requests).toContain('chapter:1'));
  rememberMediaPreview({ ...work(), id: 'suwayomi:1' });
  updateSettings({ suwayomiUrl: 'http://new-source.fixture' });
  expect(mediaPreview('suwayomi:1')).toBeUndefined();
  gates.get('chapter:1')!.resolve();
  await vi.waitFor(() => expect(metadataStatus(oldKey).pending).toBe(false));
  expect(storedMetadata<unknown[]>(oldKey)?.value).toEqual([]);
  const freshKey = watch(`chapters:v1:${sourceServerKey()}:1:1`);
  await chaptersFor([sources[0]], undefined, work(), undefined, true);
  await vi.waitFor(() => expect(metadataStatus(freshKey).pending).toBe(false));
  expect(
    (await chaptersFor([sources[0]], undefined, work(), undefined, true)).chapters[0].number,
  ).toBe(1);
});
it('opens an already displayed catalog card while its complete title metadata is still blocked', async () => {
  withTracking([work()]);
  expect(inTenant(2, () => mediaPreview(work().id))).toBeUndefined();
  gates.set('detail', deferred());
  watch('detail:anilist:301');
  const first = await mediaDetail('anilist:301', undefined, true);
  expect(first.title).toBe('Needle');
  expect(first.pending).toBe(true);
  gates.get('detail')!.resolve();
  await vi.waitFor(() => expect(metadataStatus('detail:anilist:301').pending).toBe(false));
  expect((await mediaDetail('anilist:301', undefined, true)).title).toBe('Enriched Needle');
});
it('reports a cold failure without a never-ending loading loop and retries after its cooldown', async () => {
  const key = watch('progressive:failure');
  const fail = vi.fn(async () => {
    throw new Error('Synthetic offline');
  });
  expect(await cached(key, 30_000, fail, { initial: () => [] as number[] })).toEqual([]);
  await vi.waitFor(() => expect(metadataStatus(key)).toEqual({ pending: false, partial: true }));
  await cached(key, 30_000, fail, { initial: () => [] as number[] });
  expect(fail).toHaveBeenCalledTimes(1);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31_000);
  await cached(key, 30_000, async () => [1], { initial: () => [] });
  await vi.waitFor(() => expect(metadataStatus(key).pending).toBe(false));
  expect(storedMetadata(key)?.value).toEqual([1]);
});
it('keeps available source chapters usable after another source fails', async () => {
  gates.set('chapter:2', deferred());
  failChapter = true;
  for (const id of [1, 2]) watch(`chapters:v1:${sourceServerKey()}:${id}:${id}`);
  await chaptersFor(sources, undefined, work(), undefined, true);
  await vi.waitFor(() =>
    expect(metadataStatus(`chapters:v1:${sourceServerKey()}:1:1`).pending).toBe(false),
  );
  expect((await chaptersFor(sources, undefined, work(), undefined, true)).chapters[0].number).toBe(
    1,
  );
  gates.get('chapter:2')!.resolve();
  await vi.waitFor(() =>
    expect(metadataStatus(`chapters:v1:${sourceServerKey()}:2:2`).pending).toBe(false),
  );
  const response = await chaptersFor(sources, undefined, work(), undefined, true);
  expect(response).toMatchObject({
    pending: false,
    partial: true,
    errors: [{ mangaId: 2, code: 'UPSTREAM_ERROR' }],
  });
  expect(response.chapters[0].number).toBe(1);
});
it('shows the first novel catalog while the other catalog is still blocked', async () => {
  discovery.enabled = true;
  const novel = { ...work(), type: 'NOVEL' as const, format: 'NOVEL' as const };
  discovery.open = async () => ({ items: [novel], page: 1, hasNextPage: true });
  gates.set('hardcover', deferred());
  discovery.hard = async () => {
    await gates.get('hardcover')!.promise;
    return {
      items: [{ ...novel, id: 'hardcover:2', title: 'Second Novel', anilistId: null }],
      page: 1,
      hasNextPage: false,
    };
  };
  const first = await progressiveDiscover({ kind: 'novel', page: 1 });
  expect(first.items.map((m) => m.id)).toEqual(['anilist:301']);
  expect(first.pending).toBe(true);
  const key = (
    db()
      .prepare("SELECT key FROM metadata_cache WHERE key LIKE 'discover:progressive:%'")
      .get() as { key: string }
  ).key;
  discoverKeys.add(key);
  gates.get('hardcover')!.resolve();
  await vi.waitFor(() =>
    expect(storedMetadata<{ pending: boolean }>(key)?.value.pending).toBe(false),
  );
  const final = await progressiveDiscover({ kind: 'novel', page: 1 });
  expect(final.items.map((m) => m.id)).toEqual(['anilist:301', 'hardcover:2']);
  expect(final.pending).toBe(false);
});
it('retains the nonfatal empty-page warning contract when both text catalogs are unavailable', async () => {
  discovery.enabled = true;
  discovery.open = async () => ({
    items: [],
    page: 1,
    hasNextPage: false,
    warnings: [{ provider: 'openlibrary', code: 'METADATA_UNAVAILABLE' }],
  });
  discovery.hard = async () => {
    throw new Error('Synthetic offline catalog');
  };
  const response = await progressiveDiscover({ kind: 'book', page: 1 });
  expect(response.items).toEqual([]);
  expect(response.pending).toBe(false);
  expect(response.warnings?.map((w) => w.provider).sort()).toEqual(['hardcover', 'openlibrary']);
});
it('never publishes background initial data for a revoked tenant', async () => {
  const gate = deferred();
  await inTenant(2, () =>
    cached(
      'revoked',
      30_000,
      async () => {
        await gate.promise;
        return [1];
      },
      { initial: () => [] },
    ),
  );
  revokeTenant(2);
  gate.resolve();
  await vi.waitFor(() => expect(inTenant(2, () => metadataStatus('revoked').pending)).toBe(false));
  expect(inTenant(2, () => storedMetadata('revoked'))).toBeNull();
});
