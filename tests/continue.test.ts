import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-continue-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const { saveContinue, hideContinue, continueItems } = await import('@/lib/continue');
afterAll(() => {
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
const media = (id: string, title: string, type: 'MANGA' | 'ANIME', adult = false) => ({
  id,
  title,
  coverUrl: null,
  type,
  format: null,
  origin: null,
  adult,
  color: null,
});

it('lists what was started anywhere, followed or not, newest first, per 18+ preference', async () => {
  saveContinue({
    media: media('suwayomi:5', 'Read Untracked', 'MANGA'),
    kind: 'read',
    label: 'Chapter 3',
    href: '/read/42?media=suwayomi%3A5',
    position: 0.5,
  });
  await new Promise((r) => setTimeout(r, 5));
  saveContinue({
    media: media('tmdbtv:9', 'Watched Untracked', 'ANIME'),
    kind: 'watch',
    label: 'S1 · Ep. 2',
    href: '/title/tmdb/tv-9?play=0.2',
    position: 0.3,
  });
  await new Promise((r) => setTimeout(r, 5));
  saveContinue({
    media: media('anilist:77', 'Adult Work', 'MANGA', true),
    kind: 'read',
    label: 'Chapter 1',
    href: '/read/7?media=anilist%3A77',
    position: 0.1,
  });
  expect(continueItems().map((i) => i.media.title)).toEqual([
    'Watched Untracked',
    'Read Untracked',
  ]);
  updateSettings({ adultContent: true });
  expect(continueItems()[0].media.title).toBe('Adult Work');
  updateSettings({ adultMode: true });
  expect(continueItems().map((i) => i.media.title)).toEqual(['Adult Work']);
  updateSettings({ adultContent: false });

  // Removed from the row until something new is started in it.
  hideContinue('suwayomi:5');
  expect(continueItems().map((i) => i.media.id)).not.toContain('suwayomi:5');
  saveContinue({
    media: media('suwayomi:5', 'Read Untracked', 'MANGA'),
    kind: 'read',
    label: 'Chapter 4',
    href: '/read/43?media=suwayomi%3A5',
    position: 0.1,
  });
  expect(continueItems()[0]).toMatchObject({ label: 'Chapter 4' });

  // A followed work finished in the library leaves the row.
  const done = track({
    media: { ...emptyMedia('tmdbtv:9', 'Watched Untracked', 'ANIME') },
    status: 'COMPLETED',
  });
  expect(done.status).toBe('COMPLETED');
  expect(continueItems().map((i) => i.media.id)).not.toContain('tmdbtv:9');
});
