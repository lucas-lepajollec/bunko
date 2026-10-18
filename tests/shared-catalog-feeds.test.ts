import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('@/lib/release-providers', async (original) => ({
  ...(await original<object>()),
  fetchUpdatesReleases: vi.fn(async () => []),
  fetchDexReleases: vi.fn(async () => []),
}));
vi.mock('@/lib/edition-feeds', async (original) => ({
  ...(await original<object>()),
  fetchGoogleEditions: vi.fn(async () => []),
  fetchBnfEditions: vi.fn(async () => []),
}));
vi.mock('@/lib/metron', async (original) => ({
  ...(await original<object>()),
  fetchMetronReleases: vi.fn(async () => []),
}));
vi.mock('@/lib/rakuten', async (original) => ({
  ...(await original<object>()),
  fetchRakutenReleases: vi.fn(async () => []),
}));
vi.mock('@/lib/royalroad', async (original) => ({
  ...(await original<object>()),
  refreshRoyalRoad: vi.fn(async () => []),
}));
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-shared-feeds-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, closeTenant } = await import('@/lib/db');
const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant } = await import('@/lib/tenant-context');
const { userContext } = await import('@/lib/user-context');
const { getSettings, updateSettings } = await import('@/lib/settings');
const { refreshReleases } = await import('@/lib/releases');
const { fetchMetronReleases } = await import('@/lib/metron');
afterAll(() => {
  for (const id of [1, 2]) closeTenant(id);
  accountsDb().close();
  rmSync(dir, { recursive: true, force: true });
});
it('refreshes each account once after shared catalog changes without waiting twenty minutes', async () => {
  for (const id of [1, 2])
    await inTenant(id, async () => {
      getSettings();
      db()
        .prepare("INSERT INTO worker_state(key,value) VALUES('release_refresh',?)")
        .run(String(Date.now()));
      await refreshReleases();
    });
  expect(fetchMetronReleases).not.toHaveBeenCalled();
  for (const value of ['synthetic-shared-token', '']) {
    inTenant(1, () =>
      userContext.run({ id: 1, username: 'FixtureAdmin', role: 'admin' }, () =>
        updateSettings({ metronApiToken: value }),
      ),
    );
    for (const id of [1, 2])
      await inTenant(id, async () => {
        await refreshReleases();
        await refreshReleases();
      });
  }
  expect(fetchMetronReleases).toHaveBeenCalledTimes(4);
});
