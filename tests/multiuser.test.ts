import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadBatch } from '@/types/shared';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-tenants-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { inTenant, tenantId, tenantContext, tenantPath } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const {
  db,
  track,
  listTracked,
  getTracked,
  saveBatch,
  listBatches,
  dataDir,
  closeTenant,
  statement,
  writeVersion,
} = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, getSettings, persistentSecret } = await import('@/lib/settings');
const { saveMetadata, storedMetadata, cached } = await import('@/lib/metadata-cache');
const { cachedImage, cachedImageResponse, suwayomiImageKey } = await import('@/lib/image-cache');
const { saveReleases, releaseStore } = await import('@/lib/releases');
const { planning } = await import('@/lib/planning');
const { adultResolver, recordSourceFlags, sourceAllowed, setAdultOverride } =
  await import('@/lib/adult');
const { indexedSeries, kavitaMatcher } = await import('@/lib/kavita-index');
const { libraryRoot, mapKavitaPath } = await import('@/lib/library-paths');
const { engineStatus, controlEngine } = await import('@/lib/downloads');
const { sourceHealth, recordSourceHealth } = await import('@/lib/source-preferences');
const { onWorkerWake, wakeWorker } = await import('@/lib/worker-events');
const { sse } = await import('@/lib/api');
const { storeCover } = await import('@/lib/stored-covers');
const { chapterPages } = await import('@/lib/chapter-pages');
const covers = await import('@/app/api/covers/[id]/route');
const auth = await import('@/lib/auth');
const setup = await import('@/app/api/auth/setup/route');
const users = await import('@/app/api/users/route');
const settings = await import('@/app/api/settings/route');
const tracked = await import('@/app/api/tracked/route');
const me = await import('@/app/api/me/route');
const base = 'http://tenant.test';
const pass = 'synthetic-password';
let admin = '',
  member = '';
const req = (url: string, method = 'GET', value?: unknown, cookie = admin, signal?: AbortSignal) =>
  new Request(base + url, {
    method,
    signal,
    headers: {
      Cookie: cookie,
      Origin: base,
      'Content-Type': 'application/json',
      'Accept-Language': 'fr',
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
const media = (id = 1) => ({
  ...emptyMedia(`anilist:${id}`, `Instance work ${id}`, 'MANGA'),
  anilistId: id,
  format: 'MANGA' as const,
});
const cookies = () => [admin, member];
function batch(title: string): DownloadBatch {
  return {
    id: randomUUID(),
    media: { ...media(), title },
    chapterIds: [7],
    importedIds: [],
    state: 'error',
    error: 'FIXTURE',
    chapters: [
      {
        id: 7,
        name: title,
        number: 1,
        sourceName: title,
        state: 'error',
        progress: null,
        error: 'FIXTURE',
      },
    ],
    scan: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}
beforeAll(async () => {
  const r = await setup.POST(
    req('/api/auth/setup', 'POST', { username: 'Admin', password: pass }, ''),
  );
  expect(r.status).toBe(200);
  admin = r.headers.get('set-cookie')!.split(';')[0];
  const created = await users.POST(
    req('/api/users', 'POST', { username: 'Member', password: pass, role: 'member' }),
  );
  expect(created.status).toBe(201);
  member = (await auth.login(req('/api/auth'), { username: 'Member', password: pass })).split(
    ';',
  )[0];
  // This fixture explicitly exercises the isolated layout, not legacy mount detection.
  for (const id of [1, 2])
    mkdirSync(path.join(directory, 'library', String(id)), { recursive: true });
  for (const id of [1, 2])
    inTenant(id, () => {
      updateSettings({ mediaRoot: path.join(directory, 'library', String(id)) });
      mkdirSync(path.join(libraryRoot(), 'Manga'), { recursive: true });
      updateSettings({
        suwayomiUrl: `http://upstream-${id}.test`,
        suwayomiUsername: `user-${id}`,
        suwayomiPassword: `secret-${id}`,
        kavitaUrl: `http://reader-${id}.test`,
        kavitaApiKey: `key-${id}`,
        autoImportKavita: false,
        adultContent: id === 2,
        libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
      });
      track({
        media: { ...media(), title: `Private tenant ${id}` },
        status: id === 1 ? 'PAUSED' : 'COMPLETED',
      });
      db()
        .prepare("INSERT INTO worker_state(key,value) VALUES('release_refresh',?)")
        .run(String(Date.now()));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const id of [1, 2, 3]) closeTenant(id);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});

it('checks public health through the accounts store without a tenant context', async () => {
  const health = await import('@/app/api/health/route');
  const result = tenantContext.exit(health.GET);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: 'ok' });
});
it('rejects all tenant data access without an explicit context, even after warm calls', () => {
  for (const call of [
    db,
    getSettings,
    dataDir,
    listTracked,
    listBatches,
    releaseStore,
    indexedSeries,
    libraryRoot,
    () => statement('SELECT 1'),
    () => sourceAllowed({ id: '1', name: 'one', lang: 'fr' }),
  ])
    expect(() => tenantContext.exit(() => call())).toThrow(/Tenant context/);
});
it('gives members full private settings, redacts secrets, and isolates concurrent edits', async () => {
  const results = await Promise.all(
    cookies().map((cookie) => settings.GET(req('/api/settings', 'GET', undefined, cookie))),
  );
  for (const [i, r] of results.entries()) {
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.suwayomiUrl).toBe(`http://upstream-${i + 1}.test`);
    expect(s.suwayomiPassword).toBeUndefined();
    expect(s.kavitaApiKey).toBeUndefined();
    expect(s.secretsConfigured.kavitaApiKey).toBe(true);
  }
  const edits = await Promise.all(
    cookies().map((cookie, i) =>
      settings.PATCH(
        req(
          '/api/settings',
          'PATCH',
          {
            updateIntervalMinutes: 17 + i,
            favoriteSourceIds: [String(i + 1)],
          },
          cookie,
        ),
      ),
    ),
  );
  expect(edits.map((r) => r.status)).toEqual([200, 200]);
  for (const id of [1, 2])
    inTenant(id, () =>
      expect(getSettings()).toMatchObject({
        updateIntervalMinutes: 16 + id,
        favoriteSourceIds: [String(id)],
      }),
    );
  expect((await users.GET(req('/api/users', 'GET', undefined, member))).status).toBe(403);
  expect(await (await users.GET(req('/api/users'))).json()).toMatchObject([
    { id: 1, kavitaLinked: true },
    { id: 2, kavitaLinked: true },
  ]);
  expect(await (await me.GET(req('/api/me', 'GET', undefined, member))).json()).toEqual({
    id: 2,
    username: 'Member',
    role: 'member',
    adultContent: true,
  });
  expect(
    (await me.PATCH(req('/api/me', 'PATCH', { kavitaApiKey: 'obsolete-key' }, member))).status,
  ).toBe(400);
});
it('keeps same numeric work IDs, matches, chapters, statuses and statements in distinct databases', async () => {
  for (let turn = 0; turn < 4; turn++) {
    const responses = await Promise.all(
      cookies().map((cookie) => tracked.GET(req('/api/tracked', 'GET', undefined, cookie))),
    );
    for (const [i, r] of responses.entries())
      expect(await r.json()).toMatchObject([
        { id: 1, title: `Private tenant ${i + 1}`, status: i === 0 ? 'PAUSED' : 'COMPLETED' },
      ]);
  }
  await tracked.PATCH(req('/api/tracked', 'PATCH', { id: 1, status: 'READING' }, member));
  expect(inTenant(1, () => getTracked(1)!.status)).toBe('PAUSED');
  expect(inTenant(2, () => getTracked(1)!.status)).toBe('READING');
  const prepared = [1, 2].map((id) =>
    inTenant(id, () => statement('SELECT title FROM tracked_media WHERE id=1')),
  );
  expect(prepared[0]).not.toBe(prepared[1]);
  expect(prepared.map((s) => s.get())).toEqual([
    { title: 'Private tenant 1' },
    { title: 'Private tenant 2' },
  ]);
});
it('partitions every memo: settings, content flags/identities, index/linkage, releases/planning, batches and parsed metadata', async () => {
  for (const id of [1, 2])
    inTenant(id, () => {
      recordSourceFlags([{ id: '123', name: 'Fixture', lang: 'fr', nsfw: id === 1 }]);
      recordSourceHealth('123', id === 1 ? 1 : 5000);
      setAdultOverride(media(55), 'anilist:55', id === 1);
      db()
        .prepare('INSERT INTO kavita_series VALUES(1,?)')
        .run(
          JSON.stringify({
            seriesId: 1,
            libraryId: 1,
            libraryName: `Shelf ${id}`,
            name: `Private tenant ${id}`,
            names: [`Private tenant ${id}`],
            numbers: [id],
          }),
        );
      db().prepare('UPDATE tracked_media SET kavita_series_id=1 WHERE id=1').run();
      saveBatch(batch(`Batch ${id}`));
      saveMetadata('same-key', { private: id });
      saveReleases([
        {
          id: 'same-release',
          media: { ...media(6), title: `Release ${id}` },
          chapter: id,
          volume: null,
          label: `c.${id}`,
          group: null,
          releasedAt: new Date().toISOString(),
          hasTime: true,
          provider: 'mangadex',
          trackedId: null,
        },
      ]);
    });
  for (let turn = 0; turn < 4; turn++)
    for (const id of [1, 2])
      inTenant(id, () => {
        expect(sourceAllowed({ id: '123', name: 'Fixture', lang: 'fr' })).toBe(true);
        expect(sourceHealth('123').state).toBe(id === 1 ? 'ok' : 'slow');
        expect(adultResolver()(media(55)).adult).toBe(id === 1);
        expect(indexedSeries()[0].libraryName).toBe(`Shelf ${id}`);
        expect(kavitaMatcher()(media())!.numbers).toEqual([id]);
        expect(listBatches()[0].media.title).toBe(`Batch ${id}`);
        expect(storedMetadata('same-key')!.value).toEqual({ private: id });
        expect(releaseStore()[0].media.title).toBe(`Release ${id}`);
        expect(planning({}).days.flatMap((d) => d.items)[0].media.title).toBe(`Release ${id}`);
      });
  const versions = [1, 2].map((id) => inTenant(id, () => writeVersion()));
  expect(() =>
    inTenant(2, () =>
      db().transaction(() => {
        track({ media: media(77) });
        listTracked();
        throw Error('rollback');
      })(),
    ),
  ).toThrow('rollback');
  expect(inTenant(2, () => listTracked())).toHaveLength(1);
  expect([1, 2].map((id) => inTenant(id, () => writeVersion()))).toEqual(versions);
});
it('keeps overlapping asynchronous misses, stale refreshes and SSE continuations inside their tenant', async () => {
  const outputs = await Promise.all(
    [1, 2].map((id) =>
      inTenant(id, () =>
        cached('async-private', 1, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 1 ? 12 : 1));
          return { tenant: tenantId(), url: getSettings().suwayomiUrl };
        }),
      ),
    ),
  );
  expect(outputs).toEqual([
    { tenant: 1, url: 'http://upstream-1.test' },
    { tenant: 2, url: 'http://upstream-2.test' },
  ]);
  const streams = [1, 2].map((id) =>
    inTenant(id, () =>
      sse(req('/api/test'), async (send) => {
        await new Promise((resolve) => setTimeout(resolve, id === 1 ? 7 : 1));
        send('private', { id: tenantId(), title: listTracked()[0].title });
      }),
    ),
  );
  const text = await Promise.all(streams.map((r) => r.text()));
  expect(text[0]).toContain('Private tenant 1');
  expect(text[0]).not.toContain('Private tenant 2');
  expect(text[1]).toContain('Private tenant 2');
});
it('isolates proxy bytes and same cover/page IDs on disk; mounts never resolve another instance', async () => {
  const results = await Promise.all(
    [1, 2].map((id) =>
      inTenant(id, () =>
        cachedImage('same-private-image', async () => ({
          bytes: Buffer.from(`image-${id}`),
          mime: 'image/png',
        })),
      ),
    ),
  );
  expect(results.map((r) => r.bytes.toString())).toEqual(['image-1', 'image-2']);
  for (const id of [1, 2])
    await inTenant(id, async () => {
      const r = await cachedImageResponse(req('/image'), 'same-private-image', async () => {
        throw Error('must hit disk');
      });
      expect(r.headers.get('vary')).toBe('Cookie, Authorization');
      expect(Buffer.from(await r.arrayBuffer()).toString()).toBe(`image-${id}`);
      expect(dataDir()).toBe(path.join(directory, 'users', String(id)));
      const files = readdirSync(path.join(dataDir(), 'cache', 'images'));
      expect(files).toHaveLength(1);
      expect(readFileSync(path.join(dataDir(), 'cache', 'images', files[0])).toString()).toContain(
        `image-${id}`,
      );
      expect(mapKavitaPath('/library/Manga')).toBe(
        path.join(directory, 'library', String(id), 'Manga'),
      );
      expect(mapKavitaPath(`/library/${id === 1 ? 2 : 1}/Manga`)).not.toBe(
        path.join(directory, 'library', String(id === 1 ? 2 : 1), 'Manga'),
      );
    });
});
it('serves same-ID retained covers and chapter pages from private files, rejects peer versions and library symlinks', async () => {
  const versions = [1, 2].map((id) =>
    inTenant(
      id,
      () =>
        storeCover(
          1,
          'fixture',
          'https://example.test/image',
          {
            bytes: Buffer.from(`cover-${id}`),
            mime: 'image/png',
          },
          () => true,
        )!.hash,
    ),
  );
  const responses = await Promise.all(
    cookies().map((cookie, i) =>
      covers.GET(req(`/api/covers/1?v=${versions[i]}`, 'GET', undefined, cookie)),
    ),
  );
  for (const response of responses)
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  expect(
    await Promise.all(responses.map(async (r) => Buffer.from(await r.arrayBuffer()).toString())),
  ).toEqual(['cover-1', 'cover-2']);
  expect(
    (await covers.GET(req(`/api/covers/1?v=${versions[0]}`, 'GET', undefined, member))).status,
  ).toBe(404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const id = url.includes('upstream-2') ? 2 : 1;
      if (url.endsWith('/api/graphql'))
        return Response.json({
          data: { fetchChapterPages: { pages: ['/api/v1/manga/1/chapter/0/page/0'] } },
        });
      return new Response(`page-${id}`, { headers: { 'Content-Type': 'image/png' } });
    }),
  );
  const pages = await Promise.all([1, 2].map((id) => inTenant(id, () => chapterPages(7))));
  expect(pages.map((p) => p[0].bytes.toString())).toEqual(['page-1', 'page-2']);
  for (const id of [1, 2])
    await inTenant(id, async () => {
      const stored = await cachedImage(
        suwayomiImageKey('page:/api/v1/manga/1/chapter/0/page/0'),
        async () => {
          throw new Error('Page must survive in the private disk cache');
        },
      );
      expect(stored.bytes.toString()).toBe(`page-${id}`);
    });
  const alias = path.join(directory, 'library', '2', 'Peer');
  symlinkSync(path.join(directory, 'library', '1', 'Manga'), alias);
  expect(inTenant(2, () => mapKavitaPath('/library/Peer'))).toBeNull();
  unlinkSync(alias);
});
it('isolates queue controls and wake listeners for tenants with colliding chapter IDs', async () => {
  const wakes = [vi.fn(), vi.fn()];
  const off = [1, 2].map((id) => inTenant(id, () => onWorkerWake(wakes[id - 1])));
  inTenant(2, () => wakeWorker());
  expect(wakes[0]).not.toHaveBeenCalled();
  expect(wakes[1]).toHaveBeenCalledOnce();
  off.forEach((fn) => fn());
  await inTenant(2, () => controlEngine({ action: 'pause' }));
  expect(inTenant(1, () => engineStatus().state)).toBe('STARTED');
  expect(inTenant(2, () => engineStatus().state)).toBe('STOPPED');
  await inTenant(2, () => controlEngine({ action: 'resume' }));
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? routeFiles(path.join(dir, e.name))
      : e.name === 'route.ts'
        ? [path.join(dir, e.name)]
        : [],
  );
}
it('authenticates the complete route inventory and concurrently exercises every protected handler under both tenants', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        host = new URL(url).hostname;
      if (!host.endsWith('.test'))
        return Response.json({
          data: { Page: { media: [], pageInfo: { hasNextPage: false } }, GenreCollection: [] },
          result: [],
          dataList: [],
        });
      const id = host.includes('-2') ? 2 : 1;
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      if (url.endsWith('/api/graphql'))
        return Response.json({
          data: {
            sources: { nodes: [{ id: '123', name: `Source tenant ${id}`, lang: 'fr' }] },
            extensions: { nodes: [] },
            manga: { sourceId: '123', source: { name: `Source tenant ${id}` } },
            aboutServer: { version: `tenant-${id}` },
            fetchExtensions: { clientMutationId: null },
            fetchSourceManga: { mangas: [], hasNextPage: false },
            fetchChapters: { chapters: [] },
            setSettings: { clientMutationId: null },
            ...(query.includes('source(') ? { source: { filters: [] } } : {}),
          },
        });
      if (url.includes('libraries') || url.includes('all-v2') || url.includes('volumes'))
        return Response.json([]);
      return Response.json({});
    }),
  );
  let exported = 0;
  for (const file of routeFiles(path.resolve('src/app/api'))) {
    const pathname =
      '/api/' +
      path
        .relative(path.resolve('src/app/api'), file)
        .replace(/\/route\.ts$/, '')
        .replaceAll('[id]', '123');
    const mod = await import(file);
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      if (
        !mod[method] ||
        pathname === '/api/health' ||
        pathname === '/api/auth/setup' ||
        (pathname === '/api/auth' && method !== 'DELETE')
      )
        continue;
      exported++;
      const context = { params: Promise.resolve({ id: '123' }) };
      const queries: Record<string, string> = {
        '/api/media': '?id=anilist:1',
        '/api/media/sources': '?id=anilist:1',
        '/api/tracked/covers': '?id=1',
        '/api/search': '?q=Fixture',
        '/api/search/stream': '?q=Fixture',
        '/api/manga/chapters': '?suwayomiMangaId=7',
      };
      const target = pathname + (queries[pathname] ?? '');
      const unauthorized = await mod[method](req(target, method, undefined, ''), context);
      expect(unauthorized.status, `${method} ${pathname}`).toBe(401);
      const payload = method === 'GET' ? undefined : {};
      const responses = await Promise.all(
        cookies().map((cookie) => mod[method](req(target, method, payload, cookie), context)),
      );
      for (const [i, r] of responses.entries()) {
        expect(r.status, `${method} ${pathname}, tenant ${i + 1}`).not.toBe(500);
        if (pathname === '/api/users' && i === 1) expect(r.status).toBe(403);
        else expect(r.status, `${method} ${pathname}`).not.toBe(403);
        // Infinite download SSE snapshots are checked separately; cancel rather than await forever.
        if (pathname === '/api/downloads/stream') {
          await r.body?.cancel();
          continue;
        }
        const text = await r.text();
        expect(text).not.toContain(`secret-${i === 0 ? 2 : 1}`);
        expect(text).not.toContain(`key-${i === 0 ? 2 : 1}`);
        expect(text).not.toContain(`Private tenant ${i === 0 ? 2 : 1}`);
        if (pathname === '/api/settings') expect(text).toContain(`http://upstream-${i + 1}.test`);
        if (pathname === '/api/sources') expect(text).toContain(`Source tenant ${i + 1}`);
      }
    }
  }
  expect(exported).toBeGreaterThan(50);
});
it('applies live role changes and password resets to only their account, without changing tenant ownership', async () => {
  expect((await users.PATCH(req('/api/users', 'PATCH', { id: 1, role: 'member' }))).status).toBe(
    409,
  );
  expect(
    (
      await users.POST(
        req('/api/users', 'POST', { username: 'mEmBeR', password: pass, role: 'admin' }),
      )
    ).status,
  ).toBe(409);
  expect((await users.PATCH(req('/api/users', 'PATCH', { id: 2, role: 'admin' }))).status).toBe(
    200,
  );
  expect((await users.PATCH(req('/api/users', 'PATCH', { id: 1, role: 'member' }))).status).toBe(
    200,
  );
  expect((await users.GET(req('/api/users'))).status).toBe(403);
  expect((await users.GET(req('/api/users', 'GET', undefined, member))).status).toBe(200);
  expect((await settings.GET(req('/api/settings'))).status).toBe(200);
  expect(
    (await users.PATCH(req('/api/users', 'PATCH', { id: 1, role: 'admin' }, member))).status,
  ).toBe(200);
  expect((await users.PATCH(req('/api/users', 'PATCH', { id: 2, role: 'member' }))).status).toBe(
    200,
  );
  expect(
    (
      await users.PATCH(
        req('/api/users', 'PATCH', { id: 2, password: 'replacement-member-password' }),
      )
    ).status,
  ).toBe(200);
  expect((await settings.GET(req('/api/settings', 'GET', undefined, member))).status).toBe(401);
  expect((await settings.GET(req('/api/settings'))).status).toBe(200);
  member = (
    await auth.login(req('/api/auth'), {
      username: 'Member',
      password: 'replacement-member-password',
    })
  ).split(';')[0];
  expect((await settings.GET(req('/api/settings', 'GET', undefined, member))).status).toBe(200);
  expect(inTenant(2, () => listTracked()[0].title)).toBe('Private tenant 2');
});
it('keeps display titles private when both tenants follow the same catalog work', async () => {
  for (const [i, cookie] of cookies().entries()) {
    const response = await tracked.POST(
      req('/api/tracked', 'POST', { media: media(18888) }, cookie),
    );
    const t = await response.json();
    expect(response.status).toBe(201);
    const patched = await tracked.PATCH(
      req('/api/tracked', 'PATCH', { id: t.id, displayTitle: `Instance title ${i}` }, cookie),
    );
    expect(await patched.json()).toMatchObject({
      title: `Instance title ${i}`,
      customTitle: true,
      media: { title: `Instance title ${i}` },
    });
  }
  for (const [i, cookie] of cookies().entries()) {
    const entries = await (await tracked.GET(req('/api/tracked', 'GET', undefined, cookie))).json();
    const own = entries.find((t: { anilistId: number }) => t.anilistId === 18888);
    expect(own.title).toBe(`Instance title ${i}`);
    expect(own.titleOptions).not.toContain(`Instance title ${1 - i}`);
  }
});

it('requires deletion confirmation, preserves the last admin and revokes only the deleted tenant', async () => {
  expect((await users.DELETE(req('/api/users', 'DELETE', { id: 2 }))).status).toBe(400);
  expect(existsSync(tenantPath(2))).toBe(true);
  expect(
    (await users.DELETE(req('/api/users', 'DELETE', { id: 1, confirmDeleteData: true }))).status,
  ).toBe(409);
  const token = persistentSecret('access.token', 32).toString('hex');
  expect(
    auth.authenticate(new Request(base, { headers: { Authorization: `Bearer ${token}` } })).id,
  ).toBe(1);
  expect(
    (await users.DELETE(req('/api/users', 'DELETE', { id: 2, confirmDeleteData: true }))).status,
  ).toBe(200);
  expect(existsSync(tenantPath(2))).toBe(false);
  expect((await settings.GET(req('/api/settings', 'GET', undefined, member))).status).toBe(401);
  expect((await settings.GET(req('/api/settings'))).status).toBe(200);
  expect(() => inTenant(2, () => db())).toThrow('deleted');
  expect(existsSync(tenantPath(2))).toBe(false);
  const created = await users.POST(
    req('/api/users', 'POST', { username: 'NextMember', password: pass, role: 'member' }),
  );
  expect((await created.json()).id).toBe(3);
  expect(inTenant(3, () => listTracked())).toEqual([]);
  expect(inTenant(3, () => getSettings().suwayomiUrl)).toBe('');
});
