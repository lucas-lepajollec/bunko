import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-encoding-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, closeTenant } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const trackedRoute = await import('@/app/api/tracked/route');
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

it('leaves compression to the server: a large answer is plain JSON with no encoding header', async () => {
  for (let i = 0; i < 120; i++)
    track({
      media: {
        ...emptyMedia(`mangaupdates:${910_000 + i}`, `Work ${i}`, 'MANGA'),
        synopsis: 'x'.repeat(300),
      },
      status: 'READING',
    });
  const response = await trackedRoute.GET(
    new Request('http://fixture.test/api/tracked', {
      headers: {
        Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }),
  );
  // Next strips a handler's Content-Encoding and compresses again: a body gzipped here would reach
  // the browser gzipped twice under one header (the library list unreadable).
  expect(response.headers.get('content-encoding')).toBe(null);
  const text = await response.text();
  expect(text.length).toBeGreaterThan(16 * 1024);
  expect(JSON.parse(text)).toHaveLength(120);
});
