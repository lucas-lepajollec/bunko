export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { listTracked, trackedForMedia } from '@/lib/db';
import { jellyfinPresence } from '@/lib/jellyfin';
export const GET = route(async (r) => {
  const detail = await mediaDetail(
    mediaId.parse(new URL(r.url).searchParams.get('id')),
    r.signal,
    true,
  );
  if (detail.type !== 'ANIME') return json(detail);
  // Anime: what the Jellyfin library holds for it (local index, no network).
  const tracked = trackedForMedia(detail, listTracked());
  return json({ ...detail, jellyfin: jellyfinPresence(detail, tracked?.jellyfinLink) });
});
