import { expect, it } from 'vitest';
import { jobStats, measured, trackRequest } from '@/lib/job-stats';

it('measures background jobs and names what is running', async () => {
  let during: string[] = [];
  await measured('covers', 7, async () => {
    during = jobStats().running;
    let x = 0;
    for (let i = 0; i < 2e6; i++) x += i;
    return x;
  });
  expect(during).toEqual(['covers#7']);
  const done = trackRequest('/api/media/0123456789abcdef0123');
  expect(jobStats().running).toEqual(['request /api/media/…']);
  done();
  const stats = jobStats();
  expect(stats.running).toEqual([]);
  expect(stats.totals[0]).toMatchObject({ job: 'covers', runs: 1 });
  expect(stats.recent[0]).toMatchObject({ job: 'covers', tenant: 7, failed: false });
  await expect(
    measured('jellyfin', null, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(jobStats().recent[0]).toMatchObject({ job: 'jellyfin', failed: true });
});
