import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-p2-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant, settleCatalogTasks } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, closeTenant } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const { emptyMedia } = await import('@/lib/media');
const { deduplicate } = await import('@/lib/search-engine');
const { discoverAll } = await import('@/lib/discover-all');
const { discover } = await import('@/lib/catalog');
const { discoverWebNovels } = await import('@/lib/novels');
const { comicInfo } = await import('@/lib/kavita');
const { saveMetadata } = await import('@/lib/metadata-cache');
const book = (id: string, author = 'Author A', year = 2000) => ({
  ...emptyMedia(id, 'Same Title', 'NOVEL'),
  format: 'NOVEL' as const,
  authors: [author],
  year,
});
beforeEach(() => {
  (globalThis as typeof globalThis & { __bunkoMuNext?: number }).__bunkoMuNext = 0;
  (globalThis as typeof globalThis & { __bunkoOlNext?: number }).__bunkoOlNext = 0;
  db().exec('DELETE FROM metadata_cache');
});
afterEach(async () => {
  const runtime = globalThis as typeof globalThis & {
    __bunkoDiscoverLoads?: Map<string, Promise<void>>;
    __bunkoNovelLoads?: Map<string, Promise<void>>;
  };
  await Promise.allSettled([
    ...(runtime.__bunkoDiscoverLoads?.values() ?? []),
    ...(runtime.__bunkoNovelLoads?.values() ?? []),
  ]);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
it('preserves homonymous same-provider works and conflicting creators/years across providers', () => {
  expect(deduplicate([book('hardcover:1'), book('hardcover:2')])).toHaveLength(2);
  expect(deduplicate([book('hardcover:1'), book('openlibrary:OL2W', 'Author B')])).toHaveLength(2);
  expect(
    deduplicate([book('hardcover:1'), book('openlibrary:OL2W', 'Author A', 2020)]),
  ).toHaveLength(2);
  const comics = [1, 2].map((id) => ({
    ...book(`metron:${id}`),
    type: 'MANGA' as const,
    format: 'COMIC' as const,
  }));
  expect(deduplicate(comics)).toHaveLength(2);
  expect(deduplicate([book('hardcover:1'), book('openlibrary:OL2W')])).toHaveLength(1);
});
it('keeps provider identities after a cross-provider merge, including transitive homonyms', () => {
  const a = { ...emptyMedia('anilist:1', 'Title', 'MANGA'), anilistId: 1 };
  const b = { ...emptyMedia('mangaupdates:2', 'Title', 'MANGA'), mangaUpdatesId: '2' };
  const c = { ...b, id: 'mangaupdates:3', mangaUpdatesId: '3' };
  expect(deduplicate([a, b, c])).toHaveLength(2);
});
it('returns a fast catalog lane while another provider waits, then retains every item in round-robin order', async () => {
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const providers = {
    manga: async () => ({ items: [book('hardcover:1')], page: 1, hasNextPage: true }),
    books: async () => {
      await slow;
      return {
        items: [book('openlibrary:OL2W', 'B'), book('openlibrary:OL3W', 'C')],
        page: 1,
        hasNextPage: false,
      };
    },
  };
  const first = await discoverAll('fixture:all', 1, providers);
  expect(first).toMatchObject({ pending: true, items: [{ id: 'hardcover:1' }] });
  finish();
  await vi.waitFor(async () =>
    expect((await discoverAll('fixture:all', 1, providers)).pending).toBe(false),
  );
  expect((await discoverAll('fixture:all', 1, providers)).items.map((m) => m.id)).toEqual([
    'hardcover:1',
    'openlibrary:OL2W',
    'openlibrary:OL3W',
  ]);
});
it('retains working providers on partial failure and reports complete provider failure', async () => {
  const failed = async () => {
    throw new Error('unavailable');
  };
  expect(
    (
      await discoverAll('fixture:partial', 1, {
        failed,
        good: async () => ({ items: [book('hardcover:1')], page: 1, hasNextPage: false }),
      })
    ).items,
  ).toHaveLength(1);
  await expect(discoverAll('fixture:failed', 1, { failed })).rejects.toMatchObject({
    code: 'METADATA_UNAVAILABLE',
  });
});
it('ends pending classification on failure and reports partial results instead of polling forever', async () => {
  let failed = false;
  const providers = {
    good: async () => ({ items: [book('hardcover:1')], page: 1, hasNextPage: false }),
    webnovel: async () => {
      if (failed) throw new Error('classification unavailable');
      return { items: [], page: 1, hasNextPage: false, pending: true };
    },
  };
  expect((await discoverAll('fixture:classification-failure', 1, providers)).pending).toBe(true);
  await new Promise<void>((r) => setImmediate(r));
  failed = true;
  await discoverAll('fixture:classification-failure', 1, providers);
  await vi.waitFor(async () => {
    expect(await discoverAll('fixture:classification-failure', 1, providers)).toMatchObject({
      pending: false,
      items: [{ id: 'hardcover:1' }],
      warnings: [{ provider: 'webnovel', code: 'METADATA_UNAVAILABLE' }],
    });
  });
});
it('bounds a cold all-provider wait even before any lane responds', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((r) => {
    finish = r;
  });
  const providers = {
    slow: async () => {
      await blocked;
      return { items: [book('hardcover:1')], page: 1, hasNextPage: false };
    },
  };
  try {
    expect(await discoverAll('fixture:all-slow', 1, providers)).toMatchObject({
      pending: true,
      items: [],
    });
  } finally {
    finish();
  }
  await vi.waitFor(async () =>
    expect((await discoverAll('fixture:all-slow', 1, providers)).pending).toBe(false),
  );
});
it('fans out all formats with provider pagination and refreshes new at midnight without waiting for cache expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-31T23:59:00Z'));
  (globalThis as typeof globalThis & { __bunkoOlNext?: number }).__bunkoOlNext = 0;
  (globalThis as typeof globalThis & { __bunkoMuNext?: number }).__bunkoMuNext = 0;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('anilist')) {
      expect(JSON.parse(String(init?.body)).variables.page).toBe(2);
      return Response.json({
        data: {
          Page: {
            pageInfo: { hasNextPage: true },
            media: [
              {
                id: 1,
                title: { romaji: 'Manga fixture' },
                format: 'MANGA',
                countryOfOrigin: 'JP',
                coverImage: { extraLarge: null },
              },
            ],
          },
        },
      });
    }
    if (url.includes('openlibrary')) {
      const params = new URL(url).searchParams;
      expect(params.get('page')).toBe('2');
      const nonfiction = params.get('q')!.includes('nonfiction');
      return Response.json({
        docs: [
          {
            key: `/works/OL${nonfiction ? 2 : 3}W`,
            title: nonfiction ? 'Science book' : 'Fiction book',
            subject: [nonfiction ? 'Science' : 'Fiction'],
            first_publish_year: 2000,
          },
        ],
        numFound: 20,
      });
    }
    expect(JSON.parse(String(init?.body)).page).toBe(2);
    return Response.json({
      results: [
        {
          record: {
            series_id: 4,
            title: 'Web fixture',
            year: '2000',
            type: 'Novel',
            categories: [{ category: 'Web Novel' }],
          },
        },
      ],
      total_hits: 20,
    });
  });
  const query = { kind: 'all' as const, sort: 'new' as const, page: 2, perPage: 8 };
  await discover(query);
  // This asserts completed content/cache identity, not elapsed time: upstream pacing is real.
  await settleCatalogTasks();
  expect((await discover(query)).pending).toBe(false);
  expect((await discover(query)).items.map((m) => m.id).sort()).toEqual([
    'anilist:1',
    'mangaupdates:4',
    'openlibrary:OL2W',
    'openlibrary:OL3W',
  ]);
  expect(calls).toHaveLength(4);
  vi.setSystemTime(new Date('2027-01-01T00:01:00Z'));
  await discover(query);
  await settleCatalogTasks();
  expect((await discover(query)).pending).toBe(false);
  expect(calls.filter((url) => url.includes('anilist'))).toHaveLength(2);
});
it('keeps coalesced aggregate pages separate across accounts', async () => {
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'Other','member','fixture','fixture','2026-01-01')",
    )
    .run();
  const lane = (id: number) => ({
    books: async () => ({ items: [book(`hardcover:${id}`)], page: 1, hasNextPage: false }),
  });
  const [first, second] = await Promise.all([
    discoverAll('fixture:same-key', 1, lane(1)),
    inTenant(2, () => discoverAll('fixture:same-key', 1, lane(2))),
  ]);
  expect(first.items[0].id).toBe('hardcover:1');
  expect(second.items[0].id).toBe('hardcover:2');
  expect((await discoverAll('fixture:same-key', 1, lane(99))).items[0].id).toBe('hardcover:1');
});
it('returns a cold WN page without awaiting 24 detail sheets and exposes positive classification progressively', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/series/search'))
      return Response.json({
        results: Array.from({ length: 24 }, (_, i) => ({
          record: { series_id: 100 + i, title: `Novel ${i}`, type: 'Novel' },
        })),
        total_hits: 24,
      });
    await blocked;
    return Response.json({
      series_id: Number(url.split('/').pop()),
      title: 'Proven Web Novel',
      type: 'Novel',
      categories: [{ category: 'Web Novel' }],
    });
  });
  const first = await discoverWebNovels({ kind: 'webnovel' });
  expect(first).toMatchObject({ items: [], pending: true });
  // Warm the other sheets so this test exercises classification rather than 24 seconds of pacing.
  for (let id = 101; id < 124; id++)
    saveMetadata(`mu:series:${id}`, { series_id: id, title: 'Known LN', type: 'Novel' });
  finish();
  // The background job sees the newly cached sheets and never needs another upstream call.
  await vi.waitFor(
    async () => expect((await discoverWebNovels({ kind: 'webnovel' })).pending).toBe(false),
    { timeout: 3000 },
  );
  expect((await discoverWebNovels({ kind: 'webnovel' })).items).toMatchObject([
    { id: 'mangaupdates:100', format: 'WEB_NOVEL' },
  ]);
});
it('writes only the actual selected language and omits unknown/multilingual metadata', () => {
  expect(comicInfo(book('hardcover:1'), 1, 'Chapter', 'en-US')).toContain(
    '<LanguageISO>en</LanguageISO>',
  );
  expect(comicInfo(book('hardcover:1'), 1, 'Chapter', 'de')).toContain(
    '<LanguageISO>de</LanguageISO>',
  );
  for (const lang of [undefined, 'all', 'und', 'unknown'])
    expect(comicInfo(book('hardcover:1'), 1, 'Chapter', lang)).not.toContain('LanguageISO');
});
