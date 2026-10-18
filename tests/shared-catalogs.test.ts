import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import fixture from './fixtures/optional-catalogs.json';
import { catalogSettingKeys } from '@/types/shared';

const dir = mkdtempSync(path.join(tmpdir(), 'bunko-shared-catalogs-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { accountsDb } = await import('@/lib/accounts-store');
const { db, closeTenant } = await import('@/lib/db');
const { inTenant, tenantPath } = await import('@/lib/tenant-context');
const { getSettings, encrypt } = await import('@/lib/settings');
const {
  catalogSettingsRows,
  initializeCatalogStore,
  migrateCatalogSettings,
  writeCatalogSettings,
} = await import('@/lib/catalog-settings-store');
const setup = await import('@/app/api/auth/setup/route');
const users = await import('@/app/api/users/route');
const settings = await import('@/app/api/settings/route');
const probe = await import('@/app/api/settings/test-provider/route');
const discovery = await import('@/app/api/discover/route');
const { login } = await import('@/lib/auth');
const base = 'http://shared-catalog.test';
const password = 'synthetic-catalog-password';
let admin = '',
  member = '';
function request(url: string, method = 'GET', value?: unknown, cookie = admin) {
  return new Request(base + url, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
const patch = (value: unknown, cookie = admin) =>
  settings.PATCH(request('/api/settings', 'PATCH', value, cookie));
beforeAll(async () => {
  const result = await setup.POST(
    request('/api/auth/setup', 'POST', { username: 'Admin', password }),
  );
  expect(result.status).toBe(200);
  admin = result.headers.get('set-cookie')!.split(';')[0];
  expect(
    (
      await users.POST(
        request('/api/users', 'POST', { username: 'Member', password, role: 'member' }),
      )
    ).status,
  ).toBe(201);
  member = (await login(request('/api/auth'), { username: 'Member', password })).split(';')[0];
});
beforeEach(() => {
  accountsDb().prepare('DELETE FROM catalog_settings').run();
  for (const id of [1, 2])
    inTenant(id, () => {
      db().prepare('DELETE FROM settings').run();
      db().prepare('DELETE FROM metadata_cache').run();
    });
  (
    globalThis as typeof globalThis & { __bunkoCatalogBudgets?: Map<string, number> }
  ).__bunkoCatalogBudgets?.clear();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  for (const id of [1, 2]) closeTenant(id);
  accountsDb().close();
  rmSync(dir, { recursive: true, force: true });
});

it('lets admins configure shared encrypted keys and exposes only availability to members', async () => {
  const result = await patch({
    metronApiToken: 'synthetic-metron-token',
    metronUsername: 'PrivateMetronUser',
    googleBooksApiKey: 'synthetic-google-key',
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).not.toHaveProperty('metronApiToken');
  expect(body.secretsConfigured.metronApiToken).toBe(true);
  expect(body.catalogs).toMatchObject({
    canManage: true,
    configured: { metron: true, googlebooks: true },
  });
  const encrypted = JSON.stringify(accountsDb().prepare('SELECT * FROM catalog_settings').all());
  expect(encrypted).not.toContain('synthetic-metron-token');
  expect(encrypted).not.toContain('synthetic-google-key');
  for (const id of [1, 2])
    inTenant(id, () => {
      expect(getSettings().metronApiToken).toBe('synthetic-metron-token');
      expect(
        db().prepare('SELECT 1 FROM settings WHERE key=?').get('metronApiToken'),
      ).toBeUndefined();
    });
  const shared = await (
    await settings.GET(request('/api/settings', 'GET', undefined, member))
  ).json();
  expect(shared.catalogs).toMatchObject({
    canManage: false,
    configured: { metron: true, googlebooks: true },
  });
  expect(shared.metronUsername).toBe('');
  expect(JSON.stringify(shared)).not.toMatch(
    /synthetic-metron-token|synthetic-google-key|PrivateMetronUser/,
  );
});

it('rejects all member catalog edits, clears and probes before any personal settings change or HTTP call', async () => {
  await patch({ metronApiToken: 'synthetic-metron-token' });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const key of catalogSettingKeys)
    for (const value of ['', 'replacement']) {
      const result = await patch(
        { [key]: value, suwayomiUrl: 'http://should-not-save.test' },
        member,
      );
      expect(result.status).toBe(403);
    }
  expect(inTenant(2, () => getSettings().suwayomiUrl)).toBe('');
  expect(inTenant(1, () => getSettings().metronApiToken)).toBe('synthetic-metron-token');
  const result = await probe.POST(
    request('/api/settings/test-provider', 'POST', { provider: 'metron' }, member),
  );
  expect(result.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await settings.GET(request('/api/settings', 'GET', undefined, ''))).status).toBe(401);
});

it('keeps service credentials and preferences personal while members use the shared comics catalog', async () => {
  await patch({
    suwayomiUrl: 'http://admin-source.test',
    kavitaApiKey: 'synthetic-admin-kavita',
    adultContent: true,
  });
  expect(
    (
      await patch(
        {
          suwayomiUrl: 'http://member-source.test',
          kavitaApiKey: 'synthetic-member-kavita',
          adultContent: false,
        },
        member,
      )
    ).status,
  ).toBe(200);
  expect(inTenant(1, () => getSettings())).toMatchObject({
    suwayomiUrl: 'http://admin-source.test',
    kavitaApiKey: 'synthetic-admin-kavita',
    adultContent: true,
  });
  expect(inTenant(2, () => getSettings())).toMatchObject({
    suwayomiUrl: 'http://member-source.test',
    kavitaApiKey: 'synthetic-member-kavita',
    adultContent: false,
  });
  await patch({ metronApiToken: 'synthetic-shared-metron' });
  const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-shared-metron');
    return Response.json({ results: [fixture.metronSeries], next: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await discovery.GET(request('/api/discover?kind=comic', 'GET', undefined, member));
  expect(result.status).toBe(200);
  expect((await result.json()).items[0].id).toBe('metron:15');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('uses the token without a username, prioritizes it over Basic and never falls back after rejection', async () => {
  await patch({
    metronApiToken: 'synthetic-rejected-token',
    metronUsername: 'LegacyUser',
    metronPassword: 'synthetic-legacy-password',
  });
  const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-rejected-token');
    return new Response('private upstream body', { status: 401 });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await probe.POST(
    request('/api/settings/test-provider', 'POST', { provider: 'metron' }),
  );
  expect(result.status).toBe(502);
  const body = await result.text();
  expect(body).toContain('PROVIDER_AUTH_FAILED');
  expect(body).not.toMatch(/private upstream|synthetic-rejected-token|synthetic-legacy-password/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rotates credentials across warm accounts and probe caches, then clears without reviving legacy values', async () => {
  await patch({ metronApiToken: 'synthetic-first-token' });
  // A dormant old account key must not become a fallback on global clear.
  inTenant(2, () =>
    db()
      .prepare('INSERT INTO settings VALUES(?,?)')
      .run('metronApiToken', encrypt('synthetic-old-member-token')),
  );
  const fetcher = vi.fn(async () => Response.json({ results: [], next: null }));
  vi.stubGlobal('fetch', fetcher);
  expect(
    (await probe.POST(request('/api/settings/test-provider', 'POST', { provider: 'metron' })))
      .status,
  ).toBe(200);
  await patch({ metronApiToken: 'synthetic-second-token' });
  expect(inTenant(2, () => getSettings().metronApiToken)).toBe('synthetic-second-token');
  expect(
    (await probe.POST(request('/api/settings/test-provider', 'POST', { provider: 'metron' })))
      .status,
  ).toBe(200);
  expect(
    fetcher.mock.calls.map((call) =>
      new Headers((call as unknown as [unknown, RequestInit])[1]?.headers).get('authorization'),
    ),
  ).toEqual(['Bearer synthetic-first-token', 'Bearer synthetic-second-token']);
  await patch({ metronApiToken: '', metronUsername: '', metronPassword: '' });
  expect(inTenant(2, () => getSettings().metronApiToken)).toBe('');
  const shared = await (
    await settings.GET(request('/api/settings', 'GET', undefined, member))
  ).json();
  expect(shared.catalogs.configured.metron).toBe(false);
}, 10000);

it('observes shared changes from another SQLite connection and ignores rolled-back snapshots', async () => {
  await patch({ googleBooksApiKey: 'synthetic-before' });
  inTenant(2, getSettings); // Warm both the private and shared memos.
  const other = new Database(path.join(dir, 'accounts.db'));
  try {
    other
      .prepare('UPDATE catalog_settings SET value=? WHERE key=?')
      .run(encrypt('synthetic-other-connection'), 'googleBooksApiKey');
  } finally {
    other.close();
  }
  expect(inTenant(2, () => getSettings().googleBooksApiKey)).toBe('synthetic-other-connection');
  expect(() =>
    accountsDb().transaction(() => {
      writeCatalogSettings(accountsDb(), { googleBooksApiKey: encrypt('synthetic-rolled-back') });
      expect(inTenant(2, () => getSettings().googleBooksApiKey)).toBe('synthetic-rolled-back');
      throw new Error('rollback fixture');
    })(),
  ).toThrow('rollback fixture');
  expect(inTenant(2, () => getSettings().googleBooksApiKey)).toBe('synthetic-other-connection');
});

it('migrates the oldest admin once, preserves all tenant rows and never combines different accounts', () => {
  const folder = tenantPath(100);
  mkdirSync(folder, { recursive: true });
  const old = new Database(path.join(folder, 'kaviseerr.db'));
  old.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const ciphertext = encrypt('synthetic-migrated-google');
  old.prepare('INSERT INTO settings VALUES(?,?)').run('googleBooksApiKey', ciphertext);
  old
    .prepare('INSERT INTO settings VALUES(?,?)')
    .run('suwayomiPassword', encrypt('synthetic-private-source'));
  const before = old.prepare('SELECT * FROM settings').all();
  const otherFolder = tenantPath(101);
  mkdirSync(otherFolder, { recursive: true });
  const otherAdmin = new Database(path.join(otherFolder, 'bunko.db'));
  otherAdmin.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  otherAdmin
    .prepare('INSERT INTO settings VALUES(?,?)')
    .run('metronApiToken', encrypt('synthetic-other-admin'));
  otherAdmin.close();
  const filename = path.join(dir, 'migration-accounts.db');
  let global = new Database(filename);
  global.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT);
    CREATE TABLE account_state(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO users VALUES(2,'member'),(100,'admin'),(101,'admin');`);
  initializeCatalogStore(global);
  try {
    migrateCatalogSettings(global);
    expect(catalogSettingsRows(global)).toEqual({ googleBooksApiKey: ciphertext });
    expect(old.prepare('SELECT * FROM settings').all()).toEqual(before);
    // Explicit removal survives process/connection restart despite untouched legacy rows.
    writeCatalogSettings(global, { googleBooksApiKey: encrypt('') });
    global.close();
    global = new Database(filename);
    initializeCatalogStore(global);
    migrateCatalogSettings(global);
    expect(catalogSettingsRows(global).googleBooksApiKey).not.toBe(ciphertext);
    expect(catalogSettingsRows(global)).not.toHaveProperty('suwayomiPassword');
  } finally {
    old.close();
    global.close();
  }
});

it('defers fresh-install migration until an admin exists and preserves explicit shared values', () => {
  const global = new Database(':memory:');
  global.exec(
    'CREATE TABLE account_state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT)',
  );
  initializeCatalogStore(global);
  try {
    migrateCatalogSettings(global);
    expect(
      global.prepare("SELECT 1 FROM account_state WHERE key='catalog_settings_migration'").get(),
    ).toBeUndefined();
    const folder = tenantPath(102);
    mkdirSync(folder, { recursive: true });
    const old = new Database(path.join(folder, 'bunko.db'));
    old.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    old
      .prepare('INSERT INTO settings VALUES(?,?)')
      .run('metronApiToken', encrypt('synthetic-old-admin'));
    old.close();
    const chosen = encrypt('synthetic-already-shared');
    global.prepare('INSERT INTO catalog_settings VALUES(?,?)').run('metronApiToken', chosen);
    global.exec("INSERT INTO users VALUES(102,'admin')");
    migrateCatalogSettings(global);
    expect(catalogSettingsRows(global).metronApiToken).toBe(chosen);
    expect(
      global.prepare("SELECT 1 FROM account_state WHERE key='catalog_settings_migration'").get(),
    ).toBeTruthy();
  } finally {
    global.close();
  }
});
