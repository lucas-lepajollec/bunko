import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-multiuser-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { db, track, listTracked, getTracked, addToLibrary, saveBatch, migrateV9, writeVersion } =
  await import('@/lib/db');
const { userContext, asServer } = await import('@/lib/user-context');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const { progressKey } = await import('@/lib/users');
const { withTracking, mediaDetail } = await import('@/lib/catalog');
const { saveReleases, releaseStore } = await import('@/lib/releases');
const { planning } = await import('@/lib/planning');
const { composeHome } = await import('@/lib/home');
const { updatesFeed } = await import('@/lib/updates');
const { libraryActivity } = await import('@/lib/library-activity');
const { refreshLibraryProgress } = await import('@/lib/kavita');
const { autoImportKavita } = await import('@/lib/kavita-track');
const tracked = await import('@/app/api/tracked/route');
const users = await import('@/app/api/users/route');
const me = await import('@/app/api/me/route');
const auth = await import('@/app/api/auth/route');
const setup = await import('@/app/api/auth/setup/route');
const enqueue = await import('@/app/api/downloads/enqueue/route');
const batches = await import('@/app/api/downloads/batches/route');
const control = await import('@/app/api/downloads/control/route');
const settings = await import('@/app/api/settings/route');
const base = 'http://multiuser.test';
const pass = 'synthetic-password';
const identity = (id: number, role: 'admin' | 'member' = id === 1 ? 'admin' : 'member') => ({
  id,
  username: id === 1 ? 'Admin' : `Member${id}`,
  role,
});
const as = <T>(id: number, run: () => T) => userContext.run(identity(id), run);
function req(url: string, method = 'GET', value?: unknown, cookie = '') {
  return new Request(base + url, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
function media(id: number, adult = false): UnifiedMedia {
  return {
    ...emptyMedia(`anilist:${id}`, `Work ${id}`, 'MANGA'),
    anilistId: id,
    adult,
    format: 'MANGA',
    chapters: 10,
  };
}
async function session(username: string) {
  const r = await auth.POST(req('/api/auth', 'POST', { username, password: pass }));
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0];
}
let admin = '',
  member = '',
  second = '';
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-17T12:00:00Z').getTime());
  const rt = globalThis as typeof globalThis & { __bunkoLoginAttempts?: unknown };
  delete rt.__bunkoLoginAttempts;
  db().exec(
    "DELETE FROM users;DELETE FROM sqlite_sequence WHERE name='users';DELETE FROM tracked_media;DELETE FROM settings;DELETE FROM metadata_cache;DELETE FROM chapter_releases;DELETE FROM worker_state;DELETE FROM kavita_series;DELETE FROM download_batches;DELETE FROM download_jobs;DELETE FROM kavita_dismissals;",
  );
  db().prepare("INSERT INTO worker_state VALUES('release_refresh',?)").run(String(Date.now()));
  updateSettings({ autoImportKavita: false });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('No network in multi-user fixtures');
    }),
  );
  const r = await setup.POST(req('/api/auth/setup', 'POST', { username: 'Admin', password: pass }));
  expect(r.status).toBe(200);
  admin = r.headers.get('set-cookie')!.split(';')[0];
  for (const username of ['Member2', 'Member3'])
    expect(
      (
        await users.POST(
          req('/api/users', 'POST', { username, password: pass, role: 'member' }, admin),
        )
      ).status,
    ).toBe(201);
  member = await session('Member2');
  second = await session('Member3');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

it('isolates overlapping memberships, status, creation dates, progress and unfollow cleanup', async () => {
  const a = (await (
    await tracked.POST(req('/api/tracked', 'POST', { media: media(1), status: 'READING' }, admin))
  ).json()) as TrackedMedia;
  const b = (await (
    await tracked.POST(
      req(
        '/api/tracked',
        'POST',
        { media: media(1), status: 'PAUSED', autoDownload: false },
        member,
      ),
    )
  ).json()) as TrackedMedia;
  expect(b.id).toBe(a.id);
  expect(db().prepare('SELECT COUNT(*) n FROM tracked_media').get()).toEqual({ n: 1 });
  db()
    .prepare('UPDATE user_library SET last_read=?,last_read_at=?,created_at=? WHERE user_id=?')
    .run(3, '2026-10-10T12:00:00Z', '2026-01-01T12:00:00Z', 1);
  db()
    .prepare('UPDATE user_library SET last_read=?,created_at=? WHERE user_id=?')
    .run(7, '2026-10-01T12:00:00Z', 2);
  expect(as(1, () => listTracked()[0])).toMatchObject({
    status: 'READING',
    progress: { read: 3 },
    lastReadAt: '2026-10-10T12:00:00Z',
    createdAt: '2026-01-01T12:00:00Z',
  });
  expect(as(2, () => listTracked()[0])).toMatchObject({
    status: 'PAUSED',
    progress: { read: 7 },
    lastReadAt: null,
    createdAt: '2026-10-01T12:00:00Z',
  });
  expect(await (await tracked.GET(req('/api/tracked', 'GET', undefined, second))).json()).toEqual(
    [],
  );
  expect(
    (await tracked.PATCH(req('/api/tracked', 'PATCH', { id: a.id, status: 'DROPPED' }, second)))
      .status,
  ).toBe(403);
  expect((await tracked.DELETE(req('/api/tracked', 'DELETE', { id: a.id }, second))).status).toBe(
    403,
  );
  expect(
    (
      await tracked.PATCH(
        req('/api/tracked', 'PATCH', { id: a.id, status: 'COMPLETED', backdrop: 'hidden' }, member),
      )
    ).status,
  ).toBe(200);
  expect(as(1, () => getTracked(a.id))).toMatchObject({ status: 'READING', backdrop: 'hidden' });
  expect(as(2, () => getTracked(a.id))).toMatchObject({ status: 'COMPLETED', backdrop: 'hidden' });
  expect((await tracked.DELETE(req('/api/tracked', 'DELETE', { id: a.id }, member))).status).toBe(
    200,
  );
  expect(as(2, () => listTracked())).toEqual([]);
  expect(as(1, () => listTracked())).toHaveLength(1);
  expect((await tracked.DELETE(req('/api/tracked', 'DELETE', { id: a.id }, admin))).status).toBe(
    200,
  );
  expect(asServer(listTracked)).toEqual([]);
});

it('keeps flags, content filter, updates, activity, releases, planning and home caches private', async () => {
  const a = as(1, () => track({ media: media(1) }));
  const explicit = as(1, () => track({ media: media(2, true) }));
  as(2, () => track({ media: media(1), status: 'PAUSED' }));
  as(2, () => track({ media: media(2, true) }));
  await me.PATCH(req('/api/me', 'PATCH', { adultContent: true }, member));
  const at = '2026-10-16T12:00:00Z';
  saveReleases(
    [media(1), media(2, true)].map((m, i) => ({
      id: `fixture:${i}`,
      media: m,
      chapter: 1,
      volume: null,
      label: 'c.1',
      group: null,
      releasedAt: at,
      hasTime: true,
      provider: 'mangadex',
      trackedId: explicit.id,
    })),
  );
  for (const t of [a, explicit]) {
    const id = Number(
      db()
        .prepare(
          'INSERT INTO update_entries(tracked_id,source_id,source_name,detected_at) VALUES(?,?,?,?)',
        )
        .run(t.id, '1', 'Fixture', at).lastInsertRowid,
    );
    db().prepare('INSERT INTO update_chapters VALUES(?,?,?,NULL)').run(id, t.id, 1);
  }
  for (const id of [1, 2, 3, 2, 1, 3])
    as(id, () => {
      const count = id === 2 ? 2 : id === 1 ? 1 : 0;
      expect(libraryActivity().hiddenAdult).toBe(id === 1 ? 1 : 0);
      expect(updatesFeed().entries).toHaveLength(count);
      const enriched = withTracking([media(1), media(2, true)]);
      expect(enriched[0].trackedId).toBe(id === 3 ? null : a.id);
      const feed = releaseStore(new Date('2026-10-17T12:00:00Z'));
      expect(feed).toHaveLength(id === 2 ? 2 : 1);
      expect(feed.every((r) => (id === 3 ? r.trackedId === null : r.trackedId !== null))).toBe(
        true,
      );
      const p = planning({ week: '2026-10-17', library: '1' });
      expect(p.days.flatMap((d) => d.items)).toHaveLength(count);
      expect(composeHome(feed, []).latest.manga).toHaveLength(id === 2 ? 2 : 1);
    });
  expect(await (await settings.GET(req('/api/settings', 'GET', undefined, member))).json()).toEqual(
    { adultContent: true },
  );
  await me.PATCH(req('/api/me', 'PATCH', { adultContent: false }, member));
  expect(as(2, () => releaseStore(new Date('2026-10-17T12:00:00Z')))).toHaveLength(1);
  expect(as(1, () => libraryActivity().hiddenAdult)).toBe(1);
  const anonDetail = await as(3, () => mediaDetail('anilist:1'));
  expect(anonDetail.trackedId).toBeNull();
});

it('validates users, protects the last admin and invalidates only the reset/deleted user sessions', async () => {
  expect(await (await auth.GET(req('/api/auth', 'GET', undefined, member))).json()).toMatchObject({
    userId: 2,
    role: 'member',
  });
  const duplicate = await users.POST(
    req('/api/users', 'POST', { username: 'mEmBeR2', password: pass, role: 'admin' }, admin),
  );
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: 'USERNAME_TAKEN' } });
  for (const value of [
    { username: 'bad name', password: pass, role: 'member' },
    { username: 'Valid', password: 'short', role: 'member' },
    { username: 'Valid', password: pass, role: 'owner' },
  ])
    expect((await users.POST(req('/api/users', 'POST', value, admin))).status).toBe(400);
  expect(
    (await users.PATCH(req('/api/users', 'PATCH', { id: 1, role: 'member' }, admin))).status,
  ).toBe(409);
  expect((await users.DELETE(req('/api/users', 'DELETE', { id: 1 }, admin))).status).toBe(409);
  const t = as(2, () => track({ media: media(2) }));
  expect(
    (
      await users.PATCH(
        req('/api/users', 'PATCH', { id: 2, password: 'new-member-password' }, admin),
      )
    ).status,
  ).toBe(200);
  expect((await me.GET(req('/api/me', 'GET', undefined, member))).status).toBe(401);
  expect((await me.GET(req('/api/me', 'GET', undefined, second))).status).toBe(200);
  expect((await me.GET(req('/api/me', 'GET', undefined, admin))).status).toBe(200);
  expect((await users.DELETE(req('/api/users', 'DELETE', { id: 2 }, admin))).status).toBe(200);
  expect(db().prepare('SELECT * FROM user_library WHERE user_id=2').all()).toEqual([]);
  expect(asServer(() => getTracked(t.id))).toBeDefined();
  expect(
    (await users.PATCH(req('/api/users', 'PATCH', { id: 3, role: 'admin' }, admin))).status,
  ).toBe(200);
  expect(
    (await users.PATCH(req('/api/users', 'PATCH', { id: 1, role: 'member' }, admin))).status,
  ).toBe(200);
  expect((await users.GET(req('/api/users', 'GET', undefined, admin))).status).toBe(403);
  expect((await users.GET(req('/api/users', 'GET', undefined, second))).status).toBe(200);
});

it('checks download permissions for every action and requires a batch for member queue controls', async () => {
  const a = as(1, () => track({ media: media(1) }));
  as(2, () => track({ media: media(2) }));
  const batch = {
    id: '00000000-0000-4000-8000-000000000001',
    media: a.media,
    chapterIds: [1],
    importedIds: [],
    state: 'error' as const,
    error: 'FIXTURE',
    createdAt: 'today',
    updatedAt: 'today',
    chapters: [],
    scan: null,
  };
  saveBatch(batch);
  expect(
    (
      await enqueue.POST(
        req('/api/downloads/enqueue', 'POST', { chapterIds: [1], media: a.media }, member),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await batches.POST(
        req('/api/downloads/batches', 'POST', { id: batch.id, action: 'retry' }, member),
      )
    ).status,
  ).toBe(403);
  for (const action of [
    { action: 'pause' },
    { action: 'resume' },
    { action: 'clear' },
    { action: 'retry_failed' },
    { action: 'remove', batchId: batch.id },
    { action: 'retry_failed', batchId: batch.id },
  ])
    expect((await control.POST(req('/api/downloads/control', 'POST', action, member))).status).toBe(
      403,
    );
  as(2, () => track({ media: media(1) }));
  expect(
    (
      await control.POST(
        req('/api/downloads/control', 'POST', { action: 'remove', batchId: batch.id }, member),
      )
    ).status,
  ).toBe(200);
  expect(db().prepare('SELECT * FROM download_batches').all()).toEqual([]);
  // Once followed, target validation is reached, proving the member passed authorization.
  expect(
    (
      await enqueue.POST(
        req('/api/downloads/enqueue', 'POST', { chapterIds: [1], media: a.media }, member),
      )
    ).status,
  ).toBe(409);
});

it('uses separate encrypted personal Kavita keys and the user 1 fallback, never the server key for other users', async () => {
  updateSettings({ kavitaUrl: 'http://kavita.fixture', kavitaApiKey: 'fixture-server-key' });
  for (const id of [1, 2, 3]) as(id, () => track({ media: media(1), kavitaSeriesId: 7 }));
  expect(
    (await me.PATCH(req('/api/me', 'PATCH', { kavitaApiKey: 'fixture-personal-key' }, member)))
      .status,
  ).toBe(200);
  const stored = db().prepare('SELECT kavita_key FROM users WHERE id=2').get() as {
    kavita_key: string;
  };
  expect(stored.kavita_key).not.toContain('fixture-personal-key');
  const keys: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const key = new Headers(init.headers).get('x-api-key')!;
      keys.push(key);
      return Response.json([
        {
          chapters: [
            {
              pages: 10,
              pagesRead: 10,
              maxNumber: key === 'fixture-server-key' ? 3 : 8,
              lastReadingProgressUtc: '2026-10-16T12:00:00Z',
            },
          ],
        },
      ]);
    }),
  );
  await asServer(() => refreshLibraryProgress());
  expect(keys.sort()).toEqual(['fixture-personal-key', 'fixture-server-key']);
  expect(as(1, () => listTracked()[0].progress)).toMatchObject({ read: 3, readSource: 'kavita' });
  expect(as(2, () => listTracked()[0].progress)).toMatchObject({ read: 8, readSource: 'kavita' });
  expect(as(3, () => listTracked()[0].progress)).toMatchObject({ read: null, readSource: 'none' });
  await me.PATCH(req('/api/me', 'PATCH', { kavitaApiKey: null }, member));
  expect(as(2, () => listTracked()[0].progress)).toMatchObject({ read: null, readSource: 'none' });
  expect(as(1, () => progressKey(1))).toBe('fixture-server-key');
  expect(as(2, () => progressKey(2))).toBe('');
  const own = await (await me.GET(req('/api/me', 'GET', undefined, member))).json();
  expect(own).toEqual({
    id: 2,
    username: 'Member2',
    role: 'member',
    adultContent: false,
    kavitaLinked: false,
  });
});

it('auto-imports Kavita works into admins libraries only, including already shared works', async () => {
  await users.PATCH(req('/api/users', 'PATCH', { id: 3, role: 'admin' }, admin));
  updateSettings({ autoImportKavita: true });
  db()
    .prepare('INSERT INTO kavita_series VALUES(?,?)')
    .run(
      7,
      JSON.stringify({
        seriesId: 7,
        libraryId: 1,
        libraryName: 'Manga',
        name: 'Fixture',
        names: ['Fixture'],
        folderPath: '',
        numbers: [],
        kind: 'MANGA',
        completed: true,
      }),
    );
  await autoImportKavita();
  expect(as(1, () => listTracked())).toHaveLength(1);
  expect(as(2, () => listTracked())).toHaveLength(0);
  expect(as(3, () => listTracked())).toHaveLength(1);
  expect(as(1, () => listTracked()[0].status)).toBe('COMPLETED');
  expect(as(3, () => listTracked()[0].status)).toBe('READING');
});

it('lets a member explicitly follow Kavita, preserves admin unfollows during auto-import, and allows refollow', async () => {
  updateSettings({ autoImportKavita: true });
  db()
    .prepare('INSERT INTO kavita_series VALUES(?,?)')
    .run(
      7,
      JSON.stringify({
        seriesId: 7,
        libraryId: 1,
        libraryName: 'Manga',
        name: 'Fixture',
        names: ['Fixture'],
        folder: null,
        numbers: [],
        kind: 'MANGA',
        completed: false,
      }),
    );
  await autoImportKavita();
  const t = as(1, () => listTracked()[0]);
  const route = await import('@/app/api/kavita/track/route');
  const response = await route.POST(req('/api/kavita/track', 'POST', { seriesId: 7 }, member));
  expect(response.status).toBe(200);
  expect(as(2, () => listTracked())).toHaveLength(1);
  expect(as(3, () => listTracked())).toHaveLength(0);
  expect((await tracked.DELETE(req('/api/tracked', 'DELETE', { id: t.id }, admin))).status).toBe(
    200,
  );
  await autoImportKavita();
  expect(as(1, () => listTracked())).toEqual([]);
  expect(as(2, () => listTracked())).toHaveLength(1);
  expect((await route.POST(req('/api/kavita/track', 'POST', { seriesId: 7 }, admin))).status).toBe(
    200,
  );
  expect(as(1, () => listTracked())).toHaveLength(1);
});

it('keeps interleaved asynchronous streams in their initiating user scope', async () => {
  const { route, sse } = await import('@/lib/api');
  const { currentUser } = await import('@/lib/user-context');
  const { getSettings } = await import('@/lib/settings');
  as(1, () => track({ media: media(1) }));
  as(2, () => track({ media: media(2) }));
  await me.PATCH(req('/api/me', 'PATCH', { adultContent: true }, member));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = route((r) =>
    sse(r, async (send) => {
      await gate;
      send('identity', {
        id: currentUser()!.id,
        items: listTracked().map((t) => t.media.id),
        adultContent: getSettings().adultContent,
      });
    }),
  );
  const a = await stream(req('/api/search/stream', 'GET', undefined, admin));
  const b = await stream(req('/api/search/stream', 'GET', undefined, member));
  const c = await me.GET(req('/api/me', 'GET', undefined, second));
  expect((await c.json()).id).toBe(3);
  release();
  expect(await a.text()).toContain('data: {"id":1,"items":["anilist:1"],"adultContent":false}');
  expect(await b.text()).toContain('data: {"id":2,"items":["anilist:2"],"adultContent":true}');
  expect(currentUser()).toBeUndefined();
});

it('scopes progress refresh budgets and rejects a late result after personal-key replacement', async () => {
  updateSettings({ kavitaUrl: 'http://kavita.fixture', kavitaApiKey: 'fixture-server-key' });
  for (const id of [1, 2]) as(id, () => track({ media: media(1), kavitaSeriesId: 7 }));
  await me.PATCH(req('/api/me', 'PATCH', { kavitaApiKey: 'fixture-personal-key' }, member));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const keys: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const key = new Headers(init.headers).get('x-api-key')!;
      keys.push(key);
      if (key === 'fixture-personal-key') await gate;
      return Response.json([{ chapters: [{ pages: 10, pagesRead: 10, maxNumber: 4 }] }]);
    }),
  );
  const old = tracked.GET(req('/api/tracked?refresh=progress', 'GET', undefined, member));
  while (!keys.includes('fixture-personal-key'))
    await new Promise((resolve) => setTimeout(resolve, 0));
  const owner = await tracked.GET(req('/api/tracked?refresh=progress', 'GET', undefined, admin));
  expect(owner.status).toBe(200);
  expect(keys).toContain('fixture-server-key');
  await me.PATCH(req('/api/me', 'PATCH', { kavitaApiKey: null }, member));
  release();
  await old;
  expect(as(2, () => listTracked()[0].progress)).toMatchObject({ read: null, readSource: 'none' });
  expect(as(1, () => listTracked()[0].progress)).toMatchObject({ read: 4, readSource: 'kavita' });
});

it('enriches shared download metadata for each caller, including after alternating warm reads', async () => {
  const t = as(1, () => track({ media: media(1) }));
  saveBatch({
    id: '00000000-0000-4000-8000-000000000002',
    media: { ...t.media, trackedId: t.id },
    chapterIds: [1],
    importedIds: [],
    state: 'error',
    error: 'FIXTURE',
    createdAt: 'today',
    updatedAt: 'today',
    chapters: [],
    scan: null,
  });
  for (const [cookie, expected] of [
    [admin, t.id],
    [member, null],
    [admin, t.id],
    [second, null],
  ] as const) {
    const result = await (
      await batches.GET(req('/api/downloads/batches', 'GET', undefined, cookie))
    ).json();
    expect(result[0].media.trackedId).toBe(expected);
  }
});

it('changes only the signed-in members password and issues a new personal session', async () => {
  const password = await import('@/app/api/auth/password/route');
  const changed = await password.POST(
    req(
      '/api/auth/password',
      'POST',
      { currentPassword: pass, newPassword: 'new-member-password' },
      member,
    ),
  );
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ userId: 2, role: 'member' });
  expect((await me.GET(req('/api/me', 'GET', undefined, member))).status).toBe(401);
  expect((await me.GET(req('/api/me', 'GET', undefined, admin))).status).toBe(200);
  expect((await me.GET(req('/api/me', 'GET', undefined, second))).status).toBe(200);
  expect(
    (
      await me.GET(
        req('/api/me', 'GET', undefined, changed.headers.get('set-cookie')!.split(';')[0]),
      )
    ).status,
  ).toBe(200);
});

const adminRoutes = [
  ['settings', ['PATCH']],
  ['users', ['GET', 'POST', 'PATCH', 'DELETE']],
  ['extensions', ['GET']],
  ['extensions/action', ['POST']],
  ['sources/preferences', ['PUT']],
  ['catalog/sync', ['POST']],
  ['updates/check', ['POST']],
  ['kavita/libraries', ['GET']],
  ['kavita/sync', ['POST']],
  ['arr/releases', ['GET', 'POST']],
  ['status', ['GET']],
] as const;
describe('route role enforcement', () => {
  for (const [name, methods] of adminRoutes)
    for (const method of methods)
      it(`${method} /api/${name} refuses a member before handling input`, async () => {
        const file = path.resolve('src/app/api', name, 'route.ts');
        const route = await import(file);
        const result = await route[method](
          req(`/api/${name}`, method, method === 'GET' ? undefined : {}, member),
        );
        expect(result.status).toBe(403);
        expect(await result.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        const allowed = await route[method](
          req(`/api/${name}`, method, method === 'GET' ? undefined : {}, admin),
        );
        expect([401, 403, 404]).not.toContain(allowed.status);
        await allowed.body?.cancel();
      });
});

it('requires authentication on every exported protected route and inventories the full API', async () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : e.name === 'route.ts'
          ? [path.join(dir, e.name)]
          : [],
    );
  }
  const list = files(path.resolve('src/app/api'));
  expect(list.length).toBeGreaterThan(40);
  for (const file of list) {
    const pathname =
      '/api/' +
      path
        .relative(path.resolve('src/app/api'), file)
        .replace(/\/route\.ts$/, '')
        .replaceAll('[id]', '1');
    const mod = await import(file);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      if (
        !mod[method] ||
        pathname === '/api/health' ||
        (pathname === '/api/auth' && ['GET', 'POST'].includes(method)) ||
        pathname === '/api/auth/setup'
      )
        continue;
      const r = await mod[method](req(pathname, method, method === 'GET' ? undefined : {}), {
        params: Promise.resolve({ id: '1' }),
      });
      expect(r.status, `${method} ${pathname}`).toBe(401);
    }
  }
});

it('migrates a populated pre-multi-user database copy atomically and idempotently without losing state', async () => {
  const oldFile = path.join(directory, 'old-v8.db'),
    copyFile = path.join(directory, 'migration-copy.db');
  // A disposable populated v8 fixture; never open the running installation or data/.
  await db().backup(oldFile);
  const old = new Database(oldFile);
  old.pragma('foreign_keys=ON');
  old.exec(
    "DELETE FROM users; DROP TABLE user_library; DROP TABLE user_dismissals; DROP TABLE users; DELETE FROM write_versions WHERE domain='users' OR domain LIKE 'user:%'; PRAGMA user_version=8;",
  );
  old
    .prepare('INSERT INTO administrator VALUES(1,?,?,?)')
    .run('LegacyAdmin', 'legacy-hash', 'legacy-session-epoch');
  old.prepare("INSERT INTO settings VALUES('adultContent','true')").run();
  old.prepare("INSERT INTO settings VALUES('kavitaApiKey',?)").run('encrypted-legacy-server-key');
  const insert = old.prepare(
    'INSERT INTO tracked_media(id,title,type,created_at,media_json,sources_json,status,last_read,last_read_at,progress_checked,released) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  const statuses = ['PLANNING', 'READING', 'PAUSED', 'COMPLETED', 'DROPPED'];
  old.transaction(() => {
    for (let id = 1; id <= 1200; id++) {
      insert.run(
        id,
        `Legacy ${id}`,
        'MANGA',
        `2025-01-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`,
        JSON.stringify(media(id)),
        '[]',
        statuses[id % 5],
        id % 100,
        '2026-09-10T12:00:00Z',
        1,
        110,
      );
      old
        .prepare(
          'INSERT INTO imported_chapters(chapter_id,tracked_id,media_json,number,imported_at) VALUES(?,?,?,?,?)',
        )
        .run(id, id, JSON.stringify(media(id)), 1, '2026-09-01T12:00:00Z');
      old
        .prepare('INSERT INTO observed_chapters VALUES(?,?,?,?,?)')
        .run(id, id, 2, '123', 'Fixture');
    }
  })();
  old.prepare('INSERT INTO download_batches VALUES(?,?)').run(
    'legacy-batch',
    JSON.stringify({
      id: 'legacy-batch',
      state: 'completed',
      media: media(1),
      chapterIds: [1],
      importedIds: [1],
    }),
  );
  old
    .prepare('INSERT INTO download_jobs VALUES(?,?)')
    .run(2, JSON.stringify({ chapterId: 2, state: 'queued' }));
  old
    .prepare('INSERT INTO source_links VALUES(?,?,?,?)')
    .run(
      1,
      '123',
      10,
      JSON.stringify({ sourceId: '123', suwayomiMangaId: 10, title: 'Legacy source' }),
    );
  const preservedTables = [
    'settings',
    'imported_chapters',
    'observed_chapters',
    'source_links',
    'download_batches',
    'download_jobs',
  ];
  const preserved = new Map(
    preservedTables.map((table) => [table, old.prepare(`SELECT * FROM ${table}`).all()]),
  );
  await old.backup(copyFile);
  old.close();
  const copy = new Database(copyFile);
  copy.pragma('foreign_keys=ON');
  const before = copy.prepare('SELECT * FROM tracked_media ORDER BY id').all();
  const versions = copy.prepare('SELECT * FROM write_versions ORDER BY domain').all();
  // Fault injection proves the migration rolls back DDL and partial copies too.
  copy.exec(
    "CREATE TRIGGER abort_legacy_retirement BEFORE DELETE ON administrator BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  expect(() => migrateV9(copy)).toThrow('fixture');
  expect(copy.pragma('user_version', { simple: true })).toBe(8);
  expect(copy.prepare("SELECT name FROM sqlite_master WHERE name='users'").get()).toBeUndefined();
  expect(copy.prepare('SELECT * FROM write_versions ORDER BY domain').all()).toEqual(versions);
  copy.exec('DROP TRIGGER abort_legacy_retirement');
  migrateV9(copy);
  migrateV9(copy);
  expect(copy.pragma('user_version', { simple: true })).toBe(9);
  expect(copy.prepare('SELECT * FROM tracked_media ORDER BY id').all()).toEqual(before);
  expect(
    copy
      .prepare(
        'SELECT id,username,role,adult_content,password_hash,session_epoch,kavita_key FROM users',
      )
      .all(),
  ).toEqual([
    {
      id: 1,
      username: 'LegacyAdmin',
      role: 'admin',
      adult_content: 1,
      password_hash: 'legacy-hash',
      session_epoch: 'legacy-session-epoch',
      kavita_key: null,
    },
  ]);
  expect(copy.prepare('SELECT COUNT(*) n FROM user_library').get()).toEqual({ n: 1200 });
  expect(copy.prepare('SELECT COUNT(*) n FROM imported_chapters').get()).toEqual({ n: 1200 });
  expect(copy.prepare('SELECT COUNT(*) n FROM observed_chapters').get()).toEqual({ n: 1200 });
  expect(
    copy
      .prepare(
        `SELECT tracked_id AS id,status,last_read,last_read_at,progress_checked,created_at FROM user_library ORDER BY tracked_id`,
      )
      .all(),
  ).toEqual(
    (before as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      status: r.status,
      last_read: r.last_read,
      last_read_at: r.last_read_at,
      progress_checked: r.progress_checked,
      created_at: r.created_at,
    })),
  );
  expect(copy.prepare("SELECT value FROM settings WHERE key='kavitaApiKey'").get()).toEqual({
    value: 'encrypted-legacy-server-key',
  });
  for (const table of preservedTables)
    expect(copy.prepare(`SELECT * FROM ${table}`).all()).toEqual(preserved.get(table));
  copy.pragma('user_version=10');
  migrateV9(copy);
  expect(copy.pragma('user_version', { simple: true })).toBe(10);
  copy.close();
});

it('keeps personal status writes out of the shared version and other users memos', async () => {
  const t = as(1, () => track({ media: media(1) }));
  as(2, () => track({ media: media(1) }));
  const shared = writeVersion(),
    other = writeVersion('user:1'),
    own = writeVersion('user:2');
  const ownBefore = as(2, () => listTracked()[0].progress);
  const otherBefore = as(1, () => listTracked()[0].progress);
  expect(
    (await tracked.PATCH(req('/api/tracked', 'PATCH', { id: t.id, status: 'PAUSED' }, member)))
      .status,
  ).toBe(200);
  expect(writeVersion()).toBe(shared);
  expect(writeVersion('user:1')).toBe(other);
  expect(writeVersion('user:2')).toBe(own + 1);
  expect(as(1, () => listTracked()[0].progress)).toBe(otherBefore);
  expect(as(2, () => listTracked()[0].progress)).not.toBe(ownBefore);
});

it('does not retain rolled-back per-user snapshots or invalidate another users write version', () => {
  as(1, () => track({ media: media(1) }));
  const other = writeVersion('user:3');
  expect(() =>
    db().transaction(() => {
      addToLibrary(2, 1);
      as(2, () => expect(listTracked()).toHaveLength(1));
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(as(2, () => listTracked())).toEqual([]);
  expect(writeVersion('user:3')).toBe(other);
});
