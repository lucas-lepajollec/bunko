export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { jobStats } from '@/lib/job-stats';

/** Background work cost (CPU and duration per job, recent runs). Administrators only. */
export const GET = route(() => {
  requireAdmin();
  return json(jobStats());
});
