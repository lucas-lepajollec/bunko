export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { BACKGROUND_JOB_IDS, backgroundJobs, runBackgroundJob } from '@/lib/background-jobs';
import { AppError } from '@/lib/errors';
import type { BackgroundJobId } from '@/types/shared';

/** The account's background jobs and their state. */
export const GET = route(() => json(backgroundJobs()));

/** Run one job now (it is queued in the account's worker, never run in the request). */
export const POST = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.string() }).strict());
  const known = (BACKGROUND_JOB_IDS as string[]).includes(id);
  if (!known || !runBackgroundJob(id as BackgroundJobId))
    throw new AppError('NOT_FOUND', 'Unknown or unavailable job', 404);
  return json({ ok: true, jobs: backgroundJobs() }, 202);
});
