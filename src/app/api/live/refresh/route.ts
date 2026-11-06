export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { liveStatus, refreshLiveNow } from '@/lib/live/live';

/** Downloads the channel index, the guides and the playlist again now. */
export const POST = route(async () => {
  await refreshLiveNow();
  return json(liveStatus());
});
