import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-rename-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'data');
process.env.BUNKO_WORKER = 'false';
const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant, tenantPath } = await import('@/lib/tenant-context');
const { closeTenant, dataDir } = await import('@/lib/db');
const { getSettings, persistentSecret } = await import('@/lib/settings');
const { mapKavitaPath, safeLibraryDirectory } = await import('@/lib/library-paths');
const users = await import('@/app/api/users/route');
const me = await import('@/app/api/me/route');
const auth = await import('@/app/api/auth/route');
const setup = await import('@/app/api/auth/setup/route');
const status = await import('@/app/api/kavita/status/route');
const settings = await import('@/app/api/settings/route');
const base = 'http://rename.test';
const password = 'synthetic-rename-password';
let admin = '',
  member = '',
  root = '';
const req = (url: string, method = 'GET', value?: unknown, cookie = admin) =>
  new Request(base + url, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
const patch = (endpoint: 'users' | 'me', username: unknown, extra = {}) =>
  endpoint === 'users'
    ? users.PATCH(req('/api/users', 'PATCH', { id: 2, username, ...extra }))
    : me.PATCH(req('/api/me', 'PATCH', { username, ...extra }, member));
const account = (id: number) => accountsDb().prepare('SELECT * FROM users WHERE id=?').get(id);
const mediaRoot = async (cookie = member) => {
  const r = await status.GET(req('/api/kavita/status', 'GET', undefined, cookie));
  expect(r.status).toBe(200);
  const value = await r.json();
  expect(Object.keys(value).sort()).toEqual([
    'mediaRoot',
    'mediaRootOptions',
    'series',
    'state',
    'syncedAt',
  ]);
  return value.mediaRoot;
};
beforeAll(async () => {
  process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'initial-library');
  const r = await setup.POST(req('/api/auth/setup', 'POST', { username: 'Admin', password }, ''));
  expect(r.status).toBe(200);
  admin = r.headers.get('set-cookie')!.split(';')[0];
  expect(
    (await users.POST(req('/api/users', 'POST', { username: 'Member', password, role: 'member' })))
      .status,
  ).toBe(201);
  const signedIn = await auth.POST(req('/api/auth', 'POST', { username: 'Member', password }, ''));
  member = signedIn.headers.get('set-cookie')!.split(';')[0];
});
beforeEach(() => {
  root = mkdtempSync(path.join(directory, 'library-'));
  process.env.BUNKO_LIBRARY_DIR = root;
  accountsDb()
    .prepare(
      "UPDATE users SET username=CASE id WHEN 1 THEN 'Admin' ELSE 'Member' END,role=CASE id WHEN 1 THEN 'admin' ELSE 'member' END",
    )
    .run();
  accountsDb().prepare('DELETE FROM login_attempts').run();
});
afterAll(() => {
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});
it('lets an admin rename another account while preserving sessions, login and tenant files', async () => {
  const previous = account(2) as Record<string, unknown>;
  const tenant = tenantPath(2);
  const inode = statSync(tenant).ino;
  const sentinel = path.join(tenant, 'rename-fixture');
  writeFileSync(sentinel, 'private fixture');
  const r = await patch('users', 'Reader.New-2');
  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toBeNull();
  expect(await r.json()).toEqual({
    id: 2,
    username: 'Reader.New-2',
    role: 'member',
    createdAt: previous.created_at,
    lastSeenAt: previous.last_seen_at,
    kavitaLinked: false,
  });
  expect(account(2)).toEqual({ ...previous, username: 'Reader.New-2' });
  expect(await (await auth.GET(req('/api/auth', 'GET', undefined, member))).json()).toMatchObject({
    authenticated: true,
    username: 'Reader.New-2',
    userId: 2,
  });
  expect(await (await me.GET(req('/api/me', 'GET', undefined, member))).json()).toMatchObject({
    id: 2,
    username: 'Reader.New-2',
  });
  expect((await settings.GET(req('/api/settings', 'GET', undefined, member))).status).toBe(200);
  expect(inTenant(2, dataDir)).toBe(tenant);
  expect(statSync(tenant).ino).toBe(inode);
  expect(readFileSync(sentinel, 'utf8')).toBe('private fixture');
  expect(existsSync(path.join(directory, 'data', 'users', 'Reader.New-2'))).toBe(false);
  const oldLogin = await auth.POST(req('/api/auth', 'POST', { username: 'Member', password }, ''));
  expect(oldLogin.status).toBe(401);
  expect(await oldLogin.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  const newLogin = await auth.POST(
    req('/api/auth', 'POST', { username: 'rEaDeR.nEw-2', password }, ''),
  );
  expect(newLogin.status).toBe(200);
  expect(await newLogin.json()).toMatchObject({
    authenticated: true,
    username: 'Reader.New-2',
    userId: 2,
  });
});
it('lets a member rename themselves together with their preference and returns the fresh identity', async () => {
  const previous = account(2) as Record<string, unknown>;
  const r = await patch('me', 'Self_Reader', { adultContent: true });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    id: 2,
    username: 'Self_Reader',
    role: 'member',
    adultContent: true,
  });
  expect(account(2)).toEqual({ ...previous, username: 'Self_Reader' });
  expect(inTenant(2, getSettings)).not.toHaveProperty('username');
  expect(await (await auth.GET(req('/api/auth', 'GET', undefined, member))).json()).toMatchObject({
    authenticated: true,
    username: 'Self_Reader',
    userId: 2,
  });
  expect(
    (await auth.POST(req('/api/auth', 'POST', { username: 'Member', password }, ''))).status,
  ).toBe(401);
  expect(
    (await auth.POST(req('/api/auth', 'POST', { username: 'Self_Reader', password }, ''))).status,
  ).toBe(200);
  expect((await users.GET(req('/api/users'))).status).toBe(200);
});
it('rejects an old-name login when the account is renamed during password verification', async () => {
  const passwords = await import('@/lib/passwords');
  const verify = passwords.verifyPassword;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spy = vi.spyOn(passwords, 'verifyPassword').mockImplementation(async (...args) => {
    started();
    await gate;
    return verify(...args);
  });
  const pending = auth.POST(req('/api/auth', 'POST', { username: 'Member', password }, ''));
  try {
    await verifying;
    expect((await patch('me', 'NewReader')).status).toBe(200);
    release();
    const r = await pending;
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  } finally {
    release();
    await pending;
    spy.mockRestore();
  }
});
it('lets an admin rename themselves and keeps the original cookie and bearer owner valid', async () => {
  const r = await users.PATCH(req('/api/users', 'PATCH', { id: 1, username: 'NewAdmin' }));
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ id: 1, username: 'NewAdmin', role: 'admin' });
  expect((await users.GET(req('/api/users'))).status).toBe(200);
  const token = persistentSecret('access.token', 32).toString('hex');
  const state = await auth.GET(
    new Request(base + '/api/auth', { headers: { Authorization: `Bearer ${token}` } }),
  );
  expect(await state.json()).toMatchObject({
    authenticated: true,
    userId: 1,
    username: 'NewAdmin',
  });
});
it.each(['users', 'me'] as const)(
  'enforces case-insensitive uniqueness and supports case-only/no-op renames via %s',
  async (endpoint) => {
    const previous = account(2);
    const r = await patch(
      endpoint,
      'aDmIn',
      endpoint === 'users'
        ? { role: 'admin', password: 'replacement-fixture-password' }
        : { adultContent: false },
    );
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: 'USERNAME_TAKEN' } });
    expect(account(2)).toEqual(previous);
    for (const name of ['mEmBeR', 'mEmBeR']) {
      const r = await patch(endpoint, name);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ id: 2, username: name });
    }
  },
);
it.each([
  '',
  'ab',
  'a'.repeat(41),
  'has space',
  '../escape',
  'name/dir',
  'a\\b',
  'éclair',
  null,
  123,
])('rejects invalid username %j on both endpoints without changing the account', async (name) => {
  const previous = account(2);
  for (const endpoint of ['users', 'me'] as const) {
    const r = await patch(endpoint, name);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(account(2)).toEqual(previous);
  }
});
it('accepts setup length/charset boundaries and rejects unknown admin targets', async () => {
  for (const name of ['A._', '...', 'x'.repeat(40)])
    expect((await patch('me', name)).status).toBe(200);
  const r = await users.PATCH(req('/api/users', 'PATCH', { id: 999, username: 'Nobody' }));
  expect(r.status).toBe(404);
  expect(await r.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
});
it('forbids members from renaming any account through /api/users or supplying an id to /api/me', async () => {
  const previous = account(1);
  for (const id of [1, 2]) {
    const r = await users.PATCH(req('/api/users', 'PATCH', { id, username: 'Hijack' }, member));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  }
  expect(
    (await me.PATCH(req('/api/me', 'PATCH', { id: 1, username: 'Hijack' }, member))).status,
  ).toBe(400);
  expect(account(1)).toEqual(previous);
});
it('keeps the chosen named folder, files and reachability through self/admin renames and restart', async () => {
  mkdirSync(path.join(root, 'Member', 'Manga'), { recursive: true });
  expect(await mediaRoot()).toBe(path.join(root, 'Member'));
  expect((await patch('me', 'Renamed')).status).toBe(200);
  mkdirSync(path.join(root, 'Renamed', 'Manga'), { recursive: true });
  mkdirSync(path.join(root, '2', 'Manga'), { recursive: true });
  expect(await mediaRoot()).toBe(path.join(root, 'Member'));
  expect(inTenant(2, () => mapKavitaPath('/library/Manga'))).toBe(
    path.join(root, 'Member', 'Manga'),
  );
  expect(await inTenant(2, () => safeLibraryDirectory(path.join(root, 'Member', 'Manga')))).toBe(
    path.join(root, 'Member', 'Manga'),
  );
  expect((await patch('users', 'ThirdName')).status).toBe(200);
  vi.resetModules();
  const restarted = await import('@/lib/media-root');
  expect(inTenant(2, restarted.resolveMediaRoot)).toBe(path.join(root, 'Member'));
  (await import('@/lib/accounts-store')).accountsDb().close();
});
it('keeps a numeric choice when named mounts appear after rename', async () => {
  mkdirSync(path.join(root, '2'));
  expect(await mediaRoot()).toBe(path.join(root, '2'));
  expect((await patch('users', 'Renamed')).status).toBe(200);
  mkdirSync(path.join(root, 'Renamed'));
  expect(await mediaRoot()).toBe(path.join(root, '2'));
});
it('keeps the legacy parent and an unconfigured member through renames', async () => {
  mkdirSync(path.join(root, 'Manga'));
  expect(await mediaRoot(admin)).toBe(root);
  expect(await mediaRoot()).toBeNull();
  expect((await patch('me', 'Renamed')).status).toBe(200);
  expect(
    (await users.PATCH(req('/api/users', 'PATCH', { id: 1, username: 'NewAdmin' }))).status,
  ).toBe(200);
  expect(await mediaRoot(admin)).toBe(root);
  expect(await mediaRoot()).toBeNull();
  expect(inTenant(2, () => mapKavitaPath('/library/Manga'))).toBeNull();
});
it('new username folders and symlinks never change or invalidate an existing choice', async () => {
  mkdirSync(path.join(root, 'Member'));
  expect(await mediaRoot()).toBe(path.join(root, 'Member'));
  symlinkSync(root, path.join(root, 'Unsafe'));
  expect((await patch('me', 'Unsafe')).status).toBe(200);
  expect(await mediaRoot()).toBe(path.join(root, 'Member'));
  expect(existsSync(path.join(root, 'Member'))).toBe(true);
});
