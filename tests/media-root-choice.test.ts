import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(path.join(tmpdir(), 'bunko-root-choice-'));
process.env.BUNKO_DATA_DIR = path.join(dir, 'data');
process.env.BUNKO_WORKER = 'false';
const { accountsDb } = await import('@/lib/accounts-store');
const { closeTenant } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { getSettings, updateSettings } = await import('@/lib/settings');
const { mediaRootStatus, mediaRootOptions } = await import('@/lib/media-root');
const { mapKavitaPath, targetFor } = await import('@/lib/library-paths');
const setup = await import('@/app/api/auth/setup/route');
const users = await import('@/app/api/users/route');
const auth = await import('@/app/api/auth/route');
const settings = await import('@/app/api/settings/route');
const status = await import('@/app/api/kavita/status/route');
const enqueue = await import('@/app/api/downloads/enqueue/route');
const { emptyMedia } = await import('@/lib/media');
const base = 'http://choice.test';
let admin = '',
  member = '',
  root = '';
const req = (url: string, method = 'GET', body?: unknown, cookie = admin) =>
  new Request(base + url, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (mediaRoot: unknown, cookie = admin, extra = {}) =>
  settings.PATCH(req('/api/settings', 'PATCH', { mediaRoot, ...extra }, cookie));
const choice = (id = 1) => inTenant(id, () => getSettings().mediaRoot);
const available = (folder: string, id = 1) =>
  inTenant(id, mediaRootOptions).find((o) => o.path === folder);
beforeAll(async () => {
  process.env.BUNKO_LIBRARY_DIR = path.join(dir, 'initial');
  const result = await setup.POST(
    req('/api/auth/setup', 'POST', { username: 'Lucas', password: 'synthetic-root-password' }, ''),
  );
  admin = result.headers.get('set-cookie')!.split(';')[0];
  expect(
    (
      await users.POST(
        req('/api/users', 'POST', {
          username: 'Alice',
          password: 'synthetic-root-password',
          role: 'member',
        }),
      )
    ).status,
  ).toBe(201);
  const signed = await auth.POST(
    req('/api/auth', 'POST', { username: 'Alice', password: 'synthetic-root-password' }, ''),
  );
  member = signed.headers.get('set-cookie')!.split(';')[0];
});
beforeEach(() => {
  root = mkdtempSync(path.join(dir, 'library-'));
  process.env.BUNKO_LIBRARY_DIR = root;
  accountsDb()
    .prepare("UPDATE users SET username=CASE id WHEN 1 THEN 'Lucas' ELSE 'Alice' END")
    .run();
});
afterAll(() => {
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  rmSync(dir, { recursive: true, force: true });
});
it('offers only the mount and real direct directories, with arbitrary folder names', async () => {
  const named = path.join(root, 'lucas-special 漫画');
  mkdirSync(path.join(named, 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'file'), 'fixture');
  symlinkSync(named, path.join(root, 'link'));
  symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'));
  expect(inTenant(1, mediaRootOptions).map((o) => o.path)).toEqual([root, named]);
  expect((await patch(null)).status).toBe(200);
  expect((await patch(named)).status).toBe(200);
  expect(choice()).toBe(named);
  expect(available(named)).toEqual({ path: named, usedBy: 'Lucas', available: true });
  expect(available(named, 2)).toMatchObject({ usedBy: 'Lucas', available: false });
  expect(available(root, 2)).toMatchObject({ usedBy: null, available: false });
  const response = await status.GET(req('/api/kavita/status'));
  expect(await response.json()).toMatchObject({
    mediaRoot: named,
    mediaRootOptions: expect.any(Array),
  });
});
it('blocks exact claims and parent/child claims, while allowing separate siblings', async () => {
  const a = path.join(root, 'a'),
    b = path.join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  expect(choice()).toBe(root);
  expect((await patch(a, member)).status).toBe(409);
  expect(await (await patch(root, member)).json()).toMatchObject({
    error: { code: 'MEDIA_ROOT_TAKEN' },
  });
  expect((await patch(null)).status).toBe(200);
  expect((await patch(a, member)).status).toBe(200);
  expect((await patch(root)).status).toBe(409);
  expect((await patch(a)).status).toBe(409);
  expect((await patch(b)).status).toBe(200);
  expect(available(root)).toMatchObject({ usedBy: null, available: false });
  expect(choice(2)).toBe(a);
  expect((await patch(null, member)).status).toBe(200);
  expect(available(a)).toMatchObject({ usedBy: null, available: true });
});
it.each(['same', 'parent-first', 'child-first'])(
  'serializes simultaneous PATCH reservations (%s)',
  async (mode) => {
    const folder = path.join(root, 'shared');
    mkdirSync(folder);
    await patch(null);
    const first = mode === 'parent-first' ? root : folder;
    const second = mode === 'child-first' ? root : folder;
    const results = await Promise.all([patch(first), patch(second, member)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await Promise.all(results.filter((r) => r.status === 409).map((r) => r.json())))[0],
    ).toMatchObject({ error: { code: 'MEDIA_ROOT_TAKEN' } });
    expect([choice(), choice(2)].filter(Boolean)).toHaveLength(1);
  },
);
it('rejects unknown, nested, normalized traversal and symlink paths without changing settings', async () => {
  const child = path.join(root, 'child');
  mkdirSync(path.join(child, 'nested'), { recursive: true });
  symlinkSync(child, path.join(root, 'link'));
  for (const value of [
    '',
    1,
    false,
    '../escape',
    root + '/',
    root + '/child/..',
    child + '/nested',
    root + '/missing',
    root + '/link',
    root + '/a\0b',
    '/tmp',
  ]) {
    expect((await patch(value)).status, String(value)).toBe(400);
  }
  expect(choice()).toBe(root);
});
it('rolls back a reservation when the accompanying settings target is invalid', async () => {
  const child = path.join(root, 'child');
  mkdirSync(child);
  await patch(null);
  const result = await patch(child, admin, {
    libraryTargets: { MANGA: { libraryId: 1, folder: '/missing/Manga' } },
    updateIntervalMinutes: 37,
  });
  expect(result.status).toBe(400);
  expect(choice()).toBeNull();
  expect(inTenant(1, getSettings).updateIntervalMinutes).not.toBe(37);
  expect((await patch(child, member)).status).toBe(200);
});
it('migrates a legacy parent even with unrelated subfolders, then persists an explicit clear', async () => {
  mkdirSync(path.join(root, 'Manga'));
  expect(choice()).toBe(root);
  expect(choice(2)).toBeNull();
  await patch(null);
  mkdirSync(path.join(root, 'Lucas'));
  expect(choice()).toBeNull();
  vi.resetModules();
  const fresh = await import('@/lib/media-root');
  expect(inTenant(1, fresh.chosenMediaRoot)).toBeNull();
  (await import('@/lib/accounts-store')).accountsDb().close();
});
it('migrates the existing named roots in preference to numeric directories once', () => {
  for (const name of ['Lucas', 'Alice', '1', '2']) mkdirSync(path.join(root, name));
  expect(choice()).toBe(path.join(root, 'Lucas'));
  expect(choice(2)).toBe(path.join(root, 'Alice'));
  rmSync(path.join(root, 'Alice'), { recursive: true });
  expect(inTenant(2, mediaRootStatus)).toBeNull();
  expect(choice(2)).toBe(path.join(root, 'Alice')); // Never fall back to 2 or release ownership.
  expect(available(root)).toMatchObject({ available: false });
});
it('restores Lucas’s legacy parent when a renamed member left only an old named folder and isolation marker', () => {
  mkdirSync(path.join(root, 'lucas-special'));
  const mountHash = createHash('sha256').update(root).digest('hex');
  accountsDb()
    .prepare('INSERT INTO account_state VALUES(?,?)')
    .run(`media_layout:${mountHash}`, 'tenant');
  accountsDb()
    .prepare('INSERT INTO account_state VALUES(?,?)')
    .run(`media_named_root:${mountHash}:2`, '1');
  expect(choice()).toBe(root);
  expect(choice(2)).toBeNull();
});
it('leaves the legacy parent null when a member explicitly owns a renamed arbitrary subfolder', () => {
  const folder = path.join(root, 'lucas-special');
  mkdirSync(folder);
  accountsDb().prepare('INSERT INTO account_media_roots VALUES(?,?,?)').run(2, root, folder);
  expect(choice()).toBeNull();
  expect(choice(2)).toBe(folder);
});
it('leaves the parent null when another working named root migrates', () => {
  mkdirSync(path.join(root, 'Alice'));
  expect(choice()).toBeNull();
  expect(choice(2)).toBe(path.join(root, 'Alice'));
});
it('makes null and missing/unsafe mounts unreachable and refuses downloads', async () => {
  mkdirSync(path.join(root, 'Manga'));
  await patch(null);
  expect(inTenant(1, () => mapKavitaPath('/library/Manga'))).toBeNull();
  expect(() => inTenant(1, () => targetFor({ type: 'MANGA', format: 'MANGA' }))).toThrow(
    /No unambiguous reachable library target/,
  );
  expect(inTenant(1, mediaRootStatus)).toBeNull();
  const download = await enqueue.POST(
    req('/api/downloads/enqueue', 'POST', {
      media: emptyMedia('anilist:1', 'Unconfigured fixture', 'MANGA'),
      chapterIds: [1],
    }),
  );
  expect(download.status).toBe(409);
  expect(await download.json()).toMatchObject({ error: { code: 'TARGET_NOT_CONFIGURED' } });
  const outside = mkdtempSync(path.join(dir, 'outside-'));
  rmSync(root, { recursive: true });
  symlinkSync(outside, root);
  expect(inTenant(1, mediaRootOptions)).toEqual([]);
  expect((await patch(root)).status).toBe(400);
});
it('releases a deleted account’s reservation', async () => {
  mkdirSync(path.join(root, 'owned'));
  await patch(null);
  await patch(path.join(root, 'owned'), member);
  // Test FK cleanup without deleting the shared fixture account used by other cases.
  accountsDb()
    .prepare(
      "INSERT INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(3,'Third','member','fixture','fixture','2026-01-01')",
    )
    .run();
  inTenant(2, () => updateSettings({ mediaRoot: null }));
  inTenant(3, () => updateSettings({ mediaRoot: path.join(root, 'owned') }));
  accountsDb().prepare('DELETE FROM users WHERE id=3').run();
  expect((await patch(path.join(root, 'owned'))).status).toBe(200);
  closeTenant(3);
});

it('does not migrate a symlink named root or fall back to its numeric directory', () => {
  mkdirSync(path.join(root, '1'));
  symlinkSync(path.join(root, '1'), path.join(root, 'Lucas'));
  expect(choice()).toBeNull();
  expect(choice(2)).toBeNull();
  expect(available(path.join(root, '1'))).toMatchObject({ available: true });
});
it('never assigns missing roots later just because their folders appear', () => {
  rmSync(root, { recursive: true });
  expect(choice()).toBeNull();
  expect(choice(2)).toBeNull();
  mkdirSync(path.join(root, 'Lucas'), { recursive: true });
  mkdirSync(path.join(root, 'Alice'));
  expect(choice()).toBeNull();
  expect(choice(2)).toBeNull();
});
