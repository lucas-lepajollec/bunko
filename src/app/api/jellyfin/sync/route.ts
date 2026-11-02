export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { requestJellyfinSync, syncJellyfinIndex } from '@/lib/jellyfin';

/** Re-read the Jellyfin library now (index, watched episodes, automatic imports). */
export const POST = route(async (r) => {
  requestJellyfinSync();
  await syncJellyfinIndex(r.signal);
  return json({ ok: true });
});
