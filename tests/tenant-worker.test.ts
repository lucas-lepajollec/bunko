import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-tenant-workers-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
vi.mock('@/lib/tracked-sources', () => ({ drainSourceMatches: vi.fn(async () => {}) }));
vi.mock('@/lib/tracked-covers', () => ({ syncTrackedCovers: vi.fn(async () => {}) }));
vi.mock('@/lib/kavita', () => ({
  importChapter: async () => {},
  scanLibrary: async () => {},
  writeMetadata: async () => {},
  refreshLibraryProgress: async () => {},
}));
const { inTenant, tenantId } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const { db, closeTenant, track } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const { runTenantWorkers, workerTick } = await import('@/lib/downloads');
const { syncTrackedCovers } = await import('@/lib/tracked-covers');
const { drainSourceMatches } = await import('@/lib/tracked-sources');
const { setWorkerValue } = await import('@/lib/updates');
afterAll(() => {
  for (let id = 1; id <= 5; id++) closeTenant(id);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});
it('runs tenant leases independently with at most two active instances, skips blank instances and never loses scope after await', async () => {
  for (let id = 1; id <= 5; id++) {
    accountsDb()
      .prepare(
        "INSERT INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(?,?,'member','hash','epoch','today')",
      )
      .run(id, `Member${id}`);
    inTenant(id, () => {
      if (id !== 5) {
        updateSettings({ suwayomiUrl: `http://fixture-${id}.test` });
        track({ media: emptyMedia(`anilist:${id}`, 'Fixture Work', 'MANGA') });
      }
      setWorkerValue('last_check_at', new Date().toISOString());
    });
  }
  let active = 0,
    maximum = 0;
  const matched: number[] = [];
  vi.mocked(drainSourceMatches).mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    const before = tenantId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tenantId()).toBe(before);
    matched.push(before);
    active--;
  });
  const covered: number[] = [];
  vi.mocked(syncTrackedCovers).mockImplementation(async () => {
    covered.push(tenantId());
  });
  await runTenantWorkers();
  expect(maximum).toBe(2);
  expect(matched.sort()).toEqual([1, 2, 3, 4]);
  expect(covered.sort()).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  for (let id = 1; id <= 5; id++)
    inTenant(id, () => {
      const lease = db().prepare('SELECT owner,expires_at FROM worker_lock').get();
      expect(Boolean(lease)).toBe(id !== 5);
    });
  // A live lease owned by another process stops only that tenant.
  inTenant(1, () =>
    db()
      .prepare("UPDATE worker_lock SET owner='another-process',expires_at=?")
      .run(Date.now() + 90_000),
  );
  matched.length = 0;
  await Promise.all([inTenant(1, workerTick), inTenant(2, workerTick)]);
  expect(matched).toEqual([2]);
});
