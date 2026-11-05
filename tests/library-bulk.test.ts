import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-bulk-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, listTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const bulk = await import('@/app/api/tracked/bulk/route');
afterAll(() => {
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
const post = (body: unknown) =>
  bulk.POST(
    new Request('http://fixture.test/api/tracked/bulk', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
const work = (n: number) =>
  track({
    media: { ...emptyMedia(`anilist:${n}`, `Work ${n}`, 'ANIME'), anilistId: n, episodes: 12 },
    status: 'PLANNING',
  });

it('acts on several works at once and ignores ids of other libraries', async () => {
  const [a, b, c] = [work(1), work(2), work(3)];
  let res = await post({ ids: [a.id, b.id, 999], action: 'status', status: 'PAUSED' });
  expect(await res.json()).toEqual({ changed: 2 });
  expect([getTracked(a.id)!.status, getTracked(c.id)!.status]).toEqual(['PAUSED', 'PLANNING']);
  await post({ ids: [a.id, c.id], action: 'favorite' });
  expect(
    listTracked()
      .filter((t) => t.favorite)
      .map((t) => t.id),
  ).toEqual(expect.arrayContaining([a.id, c.id]));
  res = await post({ ids: [b.id], action: 'complete' });
  expect(getTracked(b.id)!.status).toBe('COMPLETED');
  res = await post({ ids: [a.id, b.id], action: 'remove' });
  expect(await res.json()).toEqual({ changed: 2 });
  expect(listTracked().map((t) => t.id)).toEqual([c.id]);
});

it('refuses a status change without a status', async () => {
  const res = await post({ ids: [1], action: 'status' });
  expect(res.status).toBe(400);
});
