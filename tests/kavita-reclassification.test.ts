import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LibraryKind, LibraryTargets, UnifiedMedia } from '@/types/shared';
import { kavitaLibraryClassification } from '@/lib/library-kinds';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-reclass-'));
const root = path.join(directory, 'library');
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = root;
process.env.BUNKO_WORKER = 'false';
for (const name of ['Romans', 'Livres']) mkdirSync(path.join(root, '1', name), { recursive: true });
// Catalog lookup and cover transfers are unrelated to library classification.
vi.mock('@/lib/search-engine', async (original) => ({
  ...(await original<object>()),
  search: async () => ({ results: [], errors: [] }),
}));
vi.mock('@/lib/kavita-cover', async (original) => ({
  ...(await original<object>()),
  ensureKavitaCover: async () => {},
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, listTracked, acquireWorker, closeTenant } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { inTenant } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { withTracking } = await import('@/lib/catalog');
const { libraryKind } = await import('@/lib/library-paths');
const { composeHome } = await import('@/lib/home');
const { mediaKind } = await import('@/lib/releases');
const { syncKavitaIndex, kavitaIndexStatus, kavitaSyncRequested, indexedSeries } =
  await import('@/lib/kavita-index');
const trackedRoute = await import('@/app/api/tracked/route');
const settingsRoute = await import('@/app/api/settings/route');
const syncRoute = await import('@/app/api/kavita/sync/route');
const detailRoute = await import('@/app/api/media/route');
const targets: LibraryTargets = {
  NOVEL: { libraryId: 10, folder: '/books/Romans' },
  BOOK: { libraryId: 20, folder: '/books/Livres' },
};
let series: { id: number; libraryId: number; name: string; format: number; lastModified: string }[];
let calls: string[];
let failIndex: boolean;
let blockListing: (() => Promise<void>) | undefined;
const ln = (id: string, title = id): UnifiedMedia => ({
  ...emptyMedia(id, title, 'NOVEL'),
  format: 'LIGHT_NOVEL',
});
function request(url: string, method = 'GET', body?: unknown) {
  return new Request(`http://fixture.test/api/${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const raw = (id: number) =>
  JSON.parse(
    (
      db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(id) as {
        media_json: string;
      }
    ).media_json,
  ) as UnifiedMedia;
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM settings; DELETE FROM kavita_series; DELETE FROM worker_state; DELETE FROM metadata_cache; DELETE FROM worker_lock; DELETE FROM kavita_dismissals',
  );
  series = [
    { id: 101, libraryId: 10, name: 'Owned roman', format: 3, lastModified: '2026-10-17' },
    { id: 202, libraryId: 20, name: 'Owned book', format: 3, lastModified: '2026-10-17' },
  ];
  calls = [];
  failIndex = false;
  blockListing = undefined;
  updateSettings({
    mediaRoot: path.join(root, '1'),
    kavitaUrl: 'http://kavita.fixture',
    kavitaApiKey: 'synthetic',
    kavitaLibraryPath: '/books',
    autoImportKavita: false,
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname !== 'kavita.fixture') throw new Error('Only fixture network allowed');
    if (failIndex) return new Response('', { status: 503 });
    if (url.pathname === '/api/Library/libraries')
      return Response.json([
        { id: 10, name: 'Romans', type: 'Book', folders: ['/books/Romans'] },
        { id: 20, name: 'Livres', type: 'Book', folders: ['/books/Livres'] },
      ]);
    if (url.pathname === '/api/Series/all-v2') {
      await blockListing?.();
      const libraryId = Number(JSON.parse(String(init?.body)).statements[0].value);
      return Response.json(series.filter((s) => s.libraryId === libraryId));
    }
    if (url.pathname === '/api/Series/metadata')
      return Response.json({ summary: 'Fixture', genres: [] });
    if (url.pathname === '/api/Series/volumes') return Response.json([]);
    throw new Error('Unexpected fixture endpoint');
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  closeTenant(1);
  closeTenant(2);
  rmSync(directory, { recursive: true, force: true });
});

it('maps all eight unique targets by ID, preserves shared targets, and uses import/provider fallbacks', () => {
  const kinds: LibraryKind[] = [
    'MANGA',
    'MANHWA',
    'MANHUA',
    'COMIC',
    'LIGHT_NOVEL',
    'WEB_NOVEL',
    'NOVEL',
    'BOOK',
  ];
  for (const kind of kinds) {
    const classify = kavitaLibraryClassification({
      [kind]: { libraryId: 10, folder: '/irrelevant' },
    });
    expect(classify(ln('local:1'), { libraryId: 10, kind: 'LIGHT_NOVEL' })).toEqual({
      format: kind,
      type: ['LIGHT_NOVEL', 'WEB_NOVEL', 'NOVEL', 'BOOK'].includes(kind) ? 'NOVEL' : 'MANGA',
    });
  }
  const shared = kavitaLibraryClassification({
    NOVEL: targets.NOVEL,
    BOOK: { libraryId: 10, folder: '/another-folder' },
    LIGHT_NOVEL: { libraryId: 10, folder: '/third-folder' },
  });
  expect(shared(ln('local:1'), { libraryId: 10, kind: 'NOVEL' }).format).toBe('LIGHT_NOVEL');
  const none = kavitaLibraryClassification({ NOVEL: null, BOOK: targets.BOOK });
  for (const kind of ['NOVEL', 'BOOK', 'LIGHT_NOVEL', 'COMIC', 'MANGA'] as const)
    expect(none(ln('local:1'), { libraryId: 10, kind }).format).toBe(kind);
  expect(none(ln('local:1'), { libraryId: 10 }).format).toBe('LIGHT_NOVEL');
  expect(none(ln('local:1'), null)).toEqual({ type: 'NOVEL', format: 'LIGHT_NOVEL' });
});

it('reclassifies warm off-catalog and catalog library snapshots after settings PATCH without network or provider mutation', async () => {
  await syncKavitaIndex();
  const off = track({ media: ln('kavita:101'), kavitaSeriesId: 101 });
  const catalog = track({ media: ln('anilist:900', 'Catalog LN'), kavitaSeriesId: 202 });
  const unmatched = track({ media: ln('anilist:901', 'Unmatched LN') });
  listTracked();
  calls = [];
  const response = await settingsRoute.PATCH(
    request('settings', 'PATCH', { libraryTargets: targets }),
  );
  expect(response.status).toBe(200);
  const list = await (await trackedRoute.GET(request('tracked'))).json();
  expect(list.find((t: { id: number }) => t.id === off.id).media.format).toBe('NOVEL');
  expect(list.find((t: { id: number }) => t.id === catalog.id).media.format).toBe('BOOK');
  expect(getTracked(unmatched.id)?.media.format).toBe('LIGHT_NOVEL');
  expect(getTracked(catalog.id)?.type).toBe('NOVEL');
  expect(libraryKind(getTracked(catalog.id)!.media)).toBe('BOOK');
  expect(withTracking([raw(catalog.id)])[0].format).toBe('BOOK');
  expect(mediaKind(withTracking([raw(catalog.id)])[0])).toBe('book');
  expect(composeHome([], [raw(catalog.id)]).top).toEqual([]); // BOOK leaves LN home lanes.
  expect(raw(off.id).format).toBe('LIGHT_NOVEL');
  expect(raw(catalog.id).format).toBe('LIGHT_NOVEL');
  saveMetadata('detail:anilist:900', {
    ...raw(catalog.id),
    tags: [],
    relations: [],
    recommendations: [],
  });
  const detail = await detailRoute.GET(request('media?id=anilist:900'));
  expect((await detail.json()).format).toBe('LIGHT_NOVEL');
  expect(calls).toEqual([]);
  // Shared targets restore the original provider/current classification, including after a warm read.
  updateSettings({ libraryTargets: { NOVEL: targets.BOOK, BOOK: targets.BOOK } });
  expect(getTracked(catalog.id)?.media.format).toBe('LIGHT_NOVEL');
  updateSettings({ libraryTargets: {} });
  expect(getTracked(catalog.id)?.media.format).toBe('NOVEL'); // Kavita Book fallback.
});

it('reclassifies catalog-linked Romans/Livres after link edits and preserves catalog detail type', async () => {
  await syncKavitaIndex();
  updateSettings({ libraryTargets: targets });
  const media = {
    ...emptyMedia('anilist:910', 'Provider manga', 'MANGA'),
    format: 'MANGA' as const,
  };
  const work = track({ media });
  for (const [seriesId, format] of [
    [101, 'NOVEL'],
    [202, 'BOOK'],
    [null, 'MANGA'],
  ] as const) {
    const r = await trackedRoute.PATCH(
      request('tracked', 'PATCH', { id: work.id, kavitaSeriesId: seriesId }),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).media.format).toBe(format);
    expect(getTracked(work.id)?.type).toBe(seriesId === null ? 'MANGA' : 'NOVEL');
  }
  await trackedRoute.PATCH(request('tracked', 'PATCH', { id: work.id, kavitaSeriesId: 101 }));
  saveMetadata('detail:anilist:910', { ...media, tags: [], relations: [], recommendations: [] });
  const detail = await (await detailRoute.GET(request('media?id=anilist:910'))).json();
  expect(detail).toMatchObject({ format: 'MANGA', type: 'MANGA' });
});

it('manual sync runs inside the incremental interval despite a busy worker and waits for completion', async () => {
  await syncKavitaIndex();
  updateSettings({ libraryTargets: targets });
  const catalog = track({ media: ln('anilist:920'), kavitaSeriesId: 101 });
  expect(getTracked(catalog.id)?.media.format).toBe('NOVEL');
  expect(kavitaSyncRequested()).toBe(false);
  expect(acquireWorker('busy-fixture-worker')).toBe(true);
  const before = kavitaIndexStatus().syncedAt;
  series[0].libraryId = 20;
  calls = [];
  let release!: () => void;
  let started!: () => void;
  const listingStarted = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  blockListing = () => {
    started();
    return gate;
  };
  let completed = false;
  const pending = syncRoute.POST(request('kavita/sync', 'POST')).then((r) => {
    completed = true;
    return r;
  });
  await listingStarted;
  expect(completed).toBe(false);
  expect(kavitaIndexStatus().syncedAt).toBe(before);
  release();
  const r = await pending;
  expect(r.status).toBe(200);
  const status = await r.json();
  expect(status).toMatchObject({ ok: true, state: 'ok', series: 2, syncedAt: expect.any(String) });
  expect(Date.parse(status.syncedAt)).toBeGreaterThanOrEqual(Date.parse(before!));
  expect(getTracked(catalog.id)?.media.format).toBe('BOOK');
  expect(calls.filter((c) => c === '/api/Library/libraries')).toHaveLength(1);
  // An immediate second manual sync still lists Kavita but reuses unchanged metadata/volumes.
  calls = [];
  await syncRoute.POST(request('kavita/sync', 'POST'));
  expect(calls.filter((c) => c === '/api/Series/all-v2')).toHaveLength(2);
  expect(calls.filter((c) => /Series\/(metadata|volumes)/.test(c))).toEqual([]);
  failIndex = true;
  expect((await syncRoute.POST(request('kavita/sync', 'POST'))).status).toBe(502);
  expect(kavitaIndexStatus().state).toBe('error');
  expect(getTracked(catalog.id)?.media.format).toBe('BOOK');
});

it('scheduled sync and auto-import use the same target rule, including a shared target', async () => {
  updateSettings({ libraryTargets: targets, autoImportKavita: true });
  await syncKavitaIndex();
  expect(
    listTracked()
      .map((t) => t.media.format)
      .sort(),
  ).toEqual(['BOOK', 'NOVEL']);
  expect(listTracked().every((t) => t.media.id.startsWith('kavita:'))).toBe(true);
  series[0].libraryId = 20;
  await syncKavitaIndex();
  expect(listTracked().every((t) => t.media.format === 'BOOK')).toBe(true);
  updateSettings({ libraryTargets: { NOVEL: targets.BOOK, BOOK: targets.BOOK } });
  series.push({
    id: 303,
    libraryId: 20,
    name: 'Shared book',
    format: 3,
    lastModified: '2026-10-17',
  });
  await syncKavitaIndex();
  expect(listTracked().find((t) => t.kavitaSeriesId === 303)?.media.format).toBe('NOVEL');
  expect(indexedSeries().find((s) => s.seriesId === 303)?.kind).toBe('NOVEL');
});

it('keeps target and index projections tenant-scoped when IDs collide', async () => {
  await syncKavitaIndex();
  updateSettings({ libraryTargets: targets });
  const first = track({ media: ln('anilist:930'), kavitaSeriesId: 101 });
  expect(getTracked(first.id)?.media.format).toBe('NOVEL');
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'Other','member','fixture','fixture','2026-01-01')",
    )
    .run();
  inTenant(2, () => {
    db().exec('DELETE FROM tracked_media; DELETE FROM settings; DELETE FROM kavita_series');
    db()
      .prepare('INSERT INTO kavita_series VALUES(?,?)')
      .run(
        101,
        JSON.stringify({
          seriesId: 101,
          libraryId: 10,
          libraryName: 'Other',
          name: 'Other',
          names: ['Other'],
          folder: null,
          numbers: [],
          kind: 'COMIC',
        }),
      );
    const other = track({ media: ln('anilist:930'), kavitaSeriesId: 101 });
    expect(getTracked(other.id)?.media).toMatchObject({ format: 'COMIC', type: 'MANGA' });
    expect(getTracked(other.id)?.type).toBe('MANGA');
  });
  expect(getTracked(first.id)?.media.format).toBe('NOVEL');
});
