import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-jobs-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { backgroundJobs, runBackgroundJob, BACKGROUND_JOB_IDS } =
  await import('@/lib/background-jobs');
const { recorded } = await import('@/lib/job-runs');
const { updateSettings } = await import('@/lib/settings');
const { workerValue } = await import('@/lib/updates');
const { statement } = await import('@/lib/db');
const { messages } = await import('@/i18n/messages');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('lists only the jobs that apply, with their last run', async () => {
  const ids = () => backgroundJobs().map((j) => j.id);
  // Nothing connected: catalog releases and covers only.
  expect(ids()).toEqual(['release-ingestion', 'catalog-linking', 'covers']);
  updateSettings({ suwayomiUrl: 'http://suwayomi.test' });
  expect(ids()).toContain('update-check');
  expect(ids()).toContain('source-matching');
  // Reading kinds only: Kavita works are linked to the catalog too.
  updateSettings({ universes: ['manga'] });
  expect(ids()).toContain('catalog-linking');

  await recorded('covers', async () => undefined);
  await expect(
    recorded('update-check', async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  const jobs = Object.fromEntries(backgroundJobs().map((j) => [j.id, j]));
  expect(jobs.covers).toMatchObject({ failed: false, running: false });
  expect(jobs.covers.lastAt).not.toBeNull();
  expect(jobs['update-check'].failed).toBe(true);
});

it('runs a job on request, only when it applies', () => {
  expect(runBackgroundJob('update-check')).toBe(true);
  expect(workerValue('check_requested')).toBeTruthy();
  statement("INSERT INTO worker_state VALUES('tracked_cover_checked:1','{}')").run();
  expect(runBackgroundJob('covers')).toBe(true);
  expect(
    statement("SELECT 1 FROM worker_state WHERE key LIKE 'tracked_cover_checked:%'").get(),
  ).toBeUndefined();
  // Kavita is not connected here.
  expect(runBackgroundJob('kavita-index')).toBe(false);
});

it('names every job in every language', () => {
  for (const [lang, dict] of Object.entries(messages))
    for (const id of BACKGROUND_JOB_IDS)
      for (const key of [`jobs.name.${id}`, `jobs.desc.${id}`])
        expect((dict as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy();
  for (const [lang, dict] of Object.entries(messages))
    for (const job of backgroundJobs())
      expect((dict as Record<string, string>)[`jobs.group.${job.group}`], lang).toBeTruthy();
});

it('keeps the kind priority order the user saves', async () => {
  const { getSettings } = await import('@/lib/settings');
  updateSettings({ kindOrder: ['anime', 'comic'] });
  expect(getSettings().kindOrder.slice(0, 3)).toEqual(['anime', 'comic', 'manga']);
  expect(getSettings().kindOrder).toHaveLength(12);
});
