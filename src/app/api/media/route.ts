export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { listTracked, trackedForMedia } from '@/lib/db';
import { jellyfinPresence } from '@/lib/jellyfin';
import { seasonRef } from '@/lib/anime-franchise';
export const GET = route(async (r) => {
  const id = mediaId.parse(new URL(r.url).searchParams.get('id'));
  // A later season already known to belong to a work: open the work right away.
  const ref = id.startsWith('anilist:') ? seasonRef(Number(id.slice(8))) : null;
  if (ref?.root.anilistId && ref.root.id !== id)
    return json({
      ...ref.root,
      tags: [],
      relations: [],
      recommendations: [],
      workOf: { id: ref.root.id, season: ref.season },
      pending: true,
    });
  const detail = await mediaDetail(id, r.signal, true);
  if (detail.type !== 'ANIME') return json(detail);
  // Anime: what the Jellyfin library holds for it (local index, no network).
  const tracked = trackedForMedia(detail, listTracked());
  return json({ ...detail, jellyfin: jellyfinPresence(detail, tracked?.jellyfinLink) });
});
