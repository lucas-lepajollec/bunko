import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-reset-'));
const connections: Database.Database[] = [];
const resetRuntime = globalThis as typeof globalThis & { __bunkoAccountReset?: Set<string> };
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
async function boot(reset: string | undefined) {
  vi.resetModules();
  if (reset === undefined) delete process.env.BUNKO_RESET_ACCOUNT;
  else process.env.BUNKO_RESET_ACCOUNT = reset;
  // This is the entry point invoked by Node instrumentation on server startup.
  const { startWorker } = await import('@/lib/downloads');
  startWorker();
  const { db: tenantDb } = await import('@/lib/db');
  const { inTenant } = await import('@/lib/tenant-context');
  const db = () => inTenant(1, tenantDb);
  connections.push(db());
  const { accountsDb } = await import('@/lib/accounts-store');
  connections.push(accountsDb());
  const settings = await import('@/lib/settings');
  return {
    db,
    accountsDb,
    auth: await import('@/lib/auth'),
    settings: {
      ...settings,
      getSettings: () => inTenant(1, settings.getSettings),
      updateSettings: (patch: Parameters<typeof settings.updateSettings>[0]) =>
        inTenant(1, () => settings.updateSettings(patch)),
    },
  };
}
beforeEach(() => {
  resetRuntime.__bunkoAccountReset?.delete(directory);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.BUNKO_RESET_ACCOUNT;
  vi.restoreAllMocks();
  for (const database of connections.splice(0)) if (database.open) database.close();
});
afterAll(() => {
  resetRuntime.__bunkoAccountReset?.delete(directory);
  rmSync(directory, { recursive: true, force: true });
});

it('resets account and sessions at startup once across module bundles, preserving app data and bearer access', async () => {
  const first = await boot(undefined);
  first
    .accountsDb()
    .exec(
      "DELETE FROM users; DELETE FROM sqlite_sequence WHERE name='users'; DELETE FROM account_state WHERE key='token_user';",
    );
  first.settings.updateSettings({ kavitaUrl: 'http://fixture.invalid' });
  const credentials = { username: 'Reader', password: 'synthetic-password' };
  const request = new Request('http://reader.test');
  const oldCookie = (await first.auth.setup(request, credentials)).split(';')[0];
  const token = first.settings.persistentSecret('access.token', 32).toString('hex');
  const { emptyMedia } = await import('@/lib/media');
  first
    .accountsDb()
    .prepare(
      `INSERT INTO users(username,role,password_hash,session_epoch,created_at)
    SELECT 'Member','member',password_hash,session_epoch,created_at FROM users WHERE id=1`,
    )
    .run();
  const memberCookie = (
    await first.auth.login(request, { username: 'Member', password: credentials.password })
  ).split(';')[0];
  first.settings.updateSettings({ adultContent: true });
  first
    .db()
    .prepare('INSERT INTO tracked_media(id,title,type,created_at,media_json) VALUES(1,?,?,?,?)')
    .run(
      'Recovery fixture',
      'MANGA',
      '2025-01-01T00:00:00Z',
      JSON.stringify(emptyMedia('anilist:1', 'Recovery fixture', 'MANGA')),
    );
  first
    .db()
    .prepare(
      "UPDATE tracked_media SET status='PAUSED',last_read=7,created_at='2025-02-01T00:00:00Z' WHERE id=1",
    )
    .run();
  const restarted = await boot('true');
  expect(restarted.auth.authState(request)).toEqual({
    authenticated: false,
    setupRequired: true,
    recovery: true,
    username: null,
    userId: null,
    role: null,
  });
  const codeFile = path.join(directory, 'recovery.code');
  expect(console.info).toHaveBeenCalledExactlyOnceWith(
    `Bunko: first administrator password and sessions reset. Enter the one-time code from ${codeFile} on the setup screen.`,
  );
  const recoveryCode = readFileSync(codeFile, 'utf8').trim();
  // Without the code from the data volume, nobody can take over the administrator.
  await expect(restarted.auth.setup(request, credentials)).rejects.toMatchObject({
    code: 'RECOVERY_CODE_INVALID',
  });
  expect(restarted.settings.getSettings().kavitaUrl).toBe('http://fixture.invalid');
  expect(restarted.settings.persistentSecret('access.token', 32).toString('hex')).toBe(token);
  expect(() =>
    restarted.auth.authenticate(new Request(request, { headers: { Cookie: oldCookie } })),
  ).toThrow('Authentication');
  expect(() =>
    restarted.auth.authenticate(
      new Request(request, { headers: { Authorization: `Bearer ${token}` } }),
    ),
  ).not.toThrow();
  expect(
    restarted.auth.authState(new Request(request, { headers: { Cookie: memberCookie } })),
  ).toMatchObject({ authenticated: true, userId: 2, role: 'member' });
  expect(restarted.accountsDb().prepare('SELECT id,username FROM users WHERE id=1').get()).toEqual({
    id: 1,
    username: 'Reader',
  });
  expect(
    restarted.db().prepare('SELECT id,status,last_read,created_at FROM tracked_media').all(),
  ).toEqual([
    {
      id: 1,
      status: 'PAUSED',
      last_read: 7,
      created_at: '2025-02-01T00:00:00Z',
    },
  ]);
  const newCookie = (await restarted.auth.setup(request, { ...credentials, recoveryCode })).split(
    ';',
  )[0];
  expect(existsSync(codeFile)).toBe(false);
  const nextBundle = await boot('true');
  expect(
    nextBundle.auth.authState(new Request(request, { headers: { Cookie: newCookie } })),
  ).toMatchObject({ authenticated: true });
  expect(() =>
    nextBundle.auth.authenticate(new Request(request, { headers: { Cookie: oldCookie } })),
  ).toThrow('Authentication');
  expect(console.info).toHaveBeenCalledTimes(1);
  // Simulate a new server process: a retained flag intentionally resets on every restart.
  resetRuntime.__bunkoAccountReset?.delete(directory);
  const nextRestart = await boot('true');
  expect(nextRestart.auth.authState(request).setupRequired).toBe(true);
  expect(console.info).toHaveBeenCalledTimes(2);
});

it.each([undefined, 'false', 'TRUE', '1'])(
  'preserves the account on restart without the exact true flag: %s',
  async (flag) => {
    const first = await boot(undefined);
    first
      .accountsDb()
      .exec(
        "DELETE FROM users; DELETE FROM sqlite_sequence WHERE name='users'; DELETE FROM account_state WHERE key='token_user';",
      );
    const request = new Request('http://reader.test');
    const session = (
      await first.auth.setup(request, { username: 'Reader', password: 'synthetic-password' })
    ).split(';')[0];
    const second = await boot(flag);
    expect(second.auth.authState(new Request(request, { headers: { Cookie: session } }))).toEqual({
      authenticated: true,
      setupRequired: false,
      username: 'Reader',
      userId: 1,
      role: 'admin',
    });
    expect(console.info).not.toHaveBeenCalled();
  },
);
