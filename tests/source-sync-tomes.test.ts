import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceCandidate } from '@/types/shared';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-source-sync-'));
process.env.BUNKO_DATA_DIR = path.join(folder, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, closeTenant } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { setSourcePreferences } = await import('@/lib/source-preferences');
const { sourceServerKey } = await import('@/lib/source-server');
const { sourceMatchQueue } = await import('@/lib/source-match-state');
const { linkMatchedSources, replaceSources, matchTrackedSources } =
  await import('@/lib/tracked-sources');
const { libraryActivity } = await import('@/lib/library-activity');
const { extensionAction } = await import('@/lib/suwayomi');
const { GET } = await import('@/app/api/media/sources/route');
const { ChapterTable } = await import('@/components/chapters');
const { I18nProvider } = await import('@/i18n/I18nProvider');
const work = () => ({ ...emptyMedia('anilist:301', 'Source Work', 'MANGA'), anilistId: 301 });
const sourceList = [
  { id: '9223372036854775806', name: 'French fixture', lang: 'fr' },
  { id: '9007199254740993', name: 'English fixture', lang: 'en' },
];
const hit = (index = 0): SourceCandidate => ({
  sourceId: sourceList[index].id,
  sourceName: sourceList[index].name,
  lang: sourceList[index].lang,
  suwayomiMangaId: 10 + index,
  title: 'Source Work',
  mangaUrl: '/work',
  thumbnailUrl: null,
  score: 1,
  chapterCount: 20 + index,
});
const token = persistentSecret('access.token', 32).toString('hex');
const request = (query = '') =>
  new Request(`http://fixture.test/api/media/sources?id=anilist:301${query}`, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'fr' },
  });
let searchGate: ((source: string, signal?: AbortSignal | null) => Promise<void>) | null = null;
let chapterGate: (() => Promise<void>) | null = null;
let searchOrder: string[] = [];
let fail = false;
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM source_links; DELETE FROM metadata_cache; DELETE FROM source_health; DELETE FROM settings; DELETE FROM worker_state; DELETE FROM kavita_series; DELETE FROM reader_chapters',
  );
  mkdirSync(path.join(folder, 'library', '1'), { recursive: true });
  updateSettings({
    suwayomiUrl: 'http://source.fixture',
    mediaRoot: path.join(folder, 'library', '1'),
    autoImportKavita: false,
  });
  setSourcePreferences({ enabledSourceIds: [], languages: ['fr', 'en'] });
  saveMetadata('detail:anilist:301', { ...work(), tags: [], relations: [], recommendations: [] });
  searchGate = null;
  chapterGate = null;
  searchOrder = [];
  fail = false;
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.query?.includes('sources {'))
      return Response.json({ data: { sources: { nodes: sourceList } } });
    if (body.query?.includes('fetchSourceManga')) {
      searchOrder.push(body.variables.input.source);
      await searchGate?.(body.variables.input.source, init?.signal);
      if (fail) return new Response('{}', { status: 503 });
      const index = body.variables.input.source === sourceList[0].id ? 0 : 1;
      return Response.json({
        data: {
          fetchSourceManga: {
            mangas: [{ id: 10 + index, title: 'Source Work', url: '/work', thumbnailUrl: null }],
            hasNextPage: false,
          },
        },
      });
    }
    if (body.query?.includes('fetchChapters')) {
      await chapterGate?.();
      return Response.json({
        data: {
          fetchChapters: {
            chapters: [
              { id: 200, name: 'Ch. 20', chapterNumber: 20, isDownloaded: false, scanlator: null },
            ],
          },
        },
      });
    }
    if (body.query?.includes('query($id: Int!)'))
      return Response.json({
        data: {
          manga: {
            id: body.variables.id,
            title: 'Source Work',
            source: { id: sourceList[0].id, name: 'French fixture', lang: 'fr' },
            url: '/work',
            thumbnailUrl: null,
          },
        },
      });
    if (body.query?.includes('updateExtension'))
      return Response.json({ data: { updateExtension: { clientMutationId: null } } });
    throw new Error('Unexpected fixture request');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
it('persists confident streamed matches, updates the no-source badge and queues a release refresh without a manual edit', async () => {
  const t = track({ media: work() });
  db()
    .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
    .run(new Date().toISOString(), t.id);
  const before = libraryActivity().revision;
  const response = await GET(request());
  const stream = await response.text();
  expect(stream).toContain('event: linked');
  expect(stream).toContain('event: done');
  expect(getTracked(t.id)).toMatchObject({
    sourceMatch: 'linked',
    sources: [{ sourceId: sourceList[0].id }, { sourceId: sourceList[1].id }],
  });
  expect(getTracked(t.id)?.sourceStatus.every((s) => s.auto)).toBe(true);
  expect(libraryActivity().revision).toBeGreaterThan(before!);
  expect(libraryActivity().matching.queued).toBe(0);
  expect(
    db().prepare("SELECT value FROM worker_state WHERE key='check_requested'").get(),
  ).toBeTruthy();
});
it('preserves manual choices made while a foreground source lookup is in flight', async () => {
  const t = track({ media: work() });
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  searchGate = async () => {
    arrived();
    await gate;
  };
  const response = await GET(request());
  const text = response.text();
  await started;
  const manual = { sourceId: '789', sourceName: 'Manual', suwayomiMangaId: 77 };
  replaceSources(getTracked(t.id)!, [manual]);
  db()
    .prepare('UPDATE tracked_media SET sources_json=? WHERE id=?')
    .run(JSON.stringify([manual]), t.id);
  release();
  const events = await text;
  expect(events).not.toContain('event: linked');
  expect(getTracked(t.id)?.sources).toEqual([manual]);
});
it('keeps custom searches as suggestions rather than attaching arbitrary matches', async () => {
  const t = track({ media: work() });
  await (await GET(request('&q=My%20query'))).text();
  expect(getTracked(t.id)?.sources).toEqual([]);
});
it('retains dismissals, source namespaces and tenant boundaries for automatic links', () => {
  const t = track({ media: work() });
  db().prepare('INSERT INTO source_dismissals VALUES(?,?,?)').run(t.id, hit().sourceId, 10);
  expect(linkMatchedSources(t, [hit()])).toBeNull();
  expect(linkMatchedSources(t, [hit(1)], [], 'old-server')).toBeNull();
  expect(inTenant(2, () => linkMatchedSources(t, [hit(1)]))).toBeNull();
  const linked = linkMatchedSources(t, [hit(1)], [], sourceServerKey(), 'fr');
  expect(linked?.sources[0].suwayomiMangaId).toBe(11);
  replaceSources(linked!, linked!.sources); // An identical manual save must also stop later auto changes.
  expect(linkMatchedSources(t, [hit(), hit(1)], linked!.sources)).toBeNull();
});
it('accepts background catalog enrichment while revalidating matches against the current work', () => {
  const t = track({ media: work() });
  db()
    .prepare('UPDATE tracked_media SET media_json=? WHERE id=?')
    .run(JSON.stringify({ ...work(), altTitles: ['Other Name'] }), t.id);
  expect(linkMatchedSources(t, [hit()])?.sourceMatch).toBe('linked');
});
it.each([false, true])(
  'persists a background match before slow sources/counts and preserves a later manual edit (%s)',
  async (manualEdit) => {
    const entry = track({ media: work() });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    searchGate = async (source) => {
      if (source === sourceList[1].id) await blocked;
    };
    chapterGate = () => blocked;
    const pending = matchTrackedSources();
    const manual = { sourceId: '789', sourceName: 'Manual', suwayomiMangaId: 77 };
    try {
      await vi.waitFor(() =>
        expect(getTracked(entry.id)).toMatchObject({
          sourceMatch: 'linked',
          sources: [{ sourceId: sourceList[0].id }],
        }),
      );
      expect(db().prepare('SELECT COUNT(*) AS n FROM download_batches').get()).toEqual({ n: 0 });
      if (manualEdit) {
        replaceSources(getTracked(entry.id)!, [manual]);
        db()
          .prepare('UPDATE tracked_media SET sources_json=? WHERE id=?')
          .run(JSON.stringify([manual]), entry.id);
      }
    } finally {
      release();
      await pending;
    }
    expect(getTracked(entry.id)?.sources.map((s) => s.sourceId)).toEqual(
      manualEdit ? ['789'] : sourceList.map((s) => s.id),
    );
  },
);
it('retries failed source searches after five minutes and clears stale misses after language or extension changes', async () => {
  const t = track({ media: work() });
  fail = true;
  await matchTrackedSources();
  expect(sourceMatchQueue()).toEqual([]);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 6 * 60_000);
  expect(sourceMatchQueue().map((t) => t.id)).toContain(t.id);
  vi.useRealTimers();
  db()
    .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
    .run(new Date().toISOString(), t.id);
  setSourcePreferences({ enabledSourceIds: [], languages: ['fr'] });
  expect(sourceMatchQueue().map((t) => t.id)).toContain(t.id);
  db()
    .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
    .run(new Date().toISOString(), t.id);
  await extensionAction({ action: 'install', id: 'fixture.extension' });
  expect(sourceMatchQueue().map((t) => t.id)).toContain(t.id);
});
it('yields a stalled work at its budget, retries it soon and lets the next work finish', async () => {
  const stalled = track({ media: work() });
  const next = track({ media: { ...work(), id: 'anilist:302', anilistId: 302 } });
  searchGate = (_source, signal) =>
    new Promise((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => timeout(ms === 30_000 ? 40 : ms));
  try {
    expect(await matchTrackedSources()).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(getTracked(stalled.id)?.sources).toEqual([]);
  expect(sourceMatchQueue().map((e) => e.id)).toEqual([next.id]);
  searchGate = null;
  await matchTrackedSources();
  expect(getTracked(next.id)?.sourceMatch).toBe('linked');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 6 * 60_000);
  expect(sourceMatchQueue().map((e) => e.id)).toContain(stalled.id);
  const before = searchOrder.length;
  await matchTrackedSources();
  // Rotate extension lanes after an exhausted budget, retaining language preference in the results.
  expect(searchOrder.slice(before)).toEqual([sourceList[1].id, sourceList[0].id]);
  expect(getTracked(stalled.id)?.sources.map((s) => s.sourceId)).toEqual(
    sourceList.map((s) => s.id),
  );
  expect(
    db().prepare('SELECT 1 FROM worker_state WHERE key=?').get(`source_match_cursor:${stalled.id}`),
  ).toBeUndefined();
});
it('renders owned tomes as normal reading rows with one correction button beside the existing view switch', () => {
  const render = (byVolume: boolean, active = true) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ChapterTable, {
          chapters: [],
          priority: [],
          read: null,
          volumeRead: 2,
          selected: new Set<string>(),
          setSelected: () => {},
          choice: {},
          setChoice: () => {},
          queued: new Set<number>(),
          owned: new Set<number>(),
          ownedVolumes: new Set([1, 2, 3]),
          mediaId: 'anilist:301',
          defaultByVolume: byVolume,
          inventoryCorrection: { active, busy: false, onCorrect: () => {} },
        }),
      ),
    );
  const html = render(true);
  expect(html).toContain('Volume 3');
  expect(html).toContain('/read/local-volume-3?');
  expect(html).toContain('border-dotted');
  expect(html).toContain('Undo correction');
  expect(html).not.toContain('<select');
  expect(html).not.toContain('Owned volumes');
  expect(render(false)).not.toContain('Undo correction');
  expect(render(true, false)).toContain('These are volumes');
});
