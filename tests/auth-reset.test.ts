import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const { db } = await import('@/lib/db');
  connections.push(db());
  return { db, auth: await import('@/lib/auth'), settings: await import('@/lib/settings') };
}
beforeEach(() => {
  resetRuntime.__bunkoAccountReset?.delete(directory);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.BUNKO_RESET_ACCOUNT;
  vi.restoreAllMocks();
  for (const database of connections.splice(0)) database.close();
});
afterAll(() => {
  resetRuntime.__bunkoAccountReset?.delete(directory);
  rmSync(directory, { recursive: true, force: true });
});

it('resets account and sessions at startup once across module bundles, preserving app data and bearer access', async () => {
  const first = await boot(undefined);
  first.db().prepare('DELETE FROM administrator').run();
  first.settings.updateSettings({ kavitaUrl: 'http://fixture.invalid' });
  const credentials = { username: 'Reader', password: 'synthetic-password' };
  const request = new Request('http://reader.test');
  const oldCookie = (await first.auth.setup(request, credentials)).split(';')[0];
  const token = first.settings.persistentSecret('access.token', 32).toString('hex');
  const restarted = await boot('true');
  expect(restarted.auth.authState(request)).toEqual({
    authenticated: false,
    setupRequired: true,
    username: null,
  });
  expect(console.info).toHaveBeenCalledExactlyOnceWith(
    'Bunko: administrator account and browser sessions reset; first-start setup is required.',
  );
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
  const newCookie = (await restarted.auth.setup(request, credentials)).split(';')[0];
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
    first.db().prepare('DELETE FROM administrator').run();
    const request = new Request('http://reader.test');
    const session = (
      await first.auth.setup(request, { username: 'Reader', password: 'synthetic-password' })
    ).split(';')[0];
    const second = await boot(flag);
    expect(second.auth.authState(new Request(request, { headers: { Cookie: session } }))).toEqual({
      authenticated: true,
      setupRequired: false,
      username: 'Reader',
    });
    expect(console.info).not.toHaveBeenCalled();
  },
);
