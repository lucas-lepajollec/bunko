export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { syncStashIndex } from '@/lib/stash';

/** Re-read the Stash server now (scenes, groups, played state). */
export const POST = route(async (r) => {
  await syncStashIndex(r.signal);
  return json({ ok: true });
});
