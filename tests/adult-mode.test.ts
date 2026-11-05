import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-adult-mode-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, listTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, getSettings } = await import('@/lib/settings');
const adult = await import('@/lib/adult');
afterAll(() => {
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
const work = (n: number, isAdult: boolean) => ({
  ...emptyMedia(`anilist:${n}`, `Work ${n}`, 'MANGA'),
  anilistId: n,
  adult: isAdult,
});

it('shows no 18+, 18+ with the rest, or 18+ only', () => {
  track({ media: work(1, false), status: 'PLANNING' });
  track({ media: work(2, true), status: 'PLANNING' });
  const titles = () =>
    adult
      .visibleTracked(listTracked())
      .map((t) => t.title)
      .sort();
  const visible = (m: ReturnType<typeof work>) => adult.mediaVisibility()(m);

  expect(adult.adultScope()).toBe('off');
  expect(titles()).toEqual(['Work 1']);
  expect([visible(work(3, false)), visible(work(4, true))]).toEqual([true, false]);

  // The switch alone does nothing while 18+ is not allowed.
  updateSettings({ adultMode: true });
  expect(adult.adultScope()).toBe('off');

  updateSettings({ adultContent: true, adultMode: false });
  expect(adult.adultScope()).toBe('on');
  expect(titles()).toEqual(['Work 1', 'Work 2']);

  updateSettings({ adultMode: true });
  expect(adult.adultScope()).toBe('only');
  expect(titles()).toEqual(['Work 2']);
  expect([visible(work(3, false)), visible(work(4, true))]).toEqual([false, true]);
  expect(adult.adultKey()).toBe('only');

  // Turning 18+ off leaves the 18+ only mode too.
  updateSettings({ adultContent: false });
  expect(getSettings().adultMode).toBe(false);
  expect(titles()).toEqual(['Work 1']);
});
