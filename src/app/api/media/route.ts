export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { listTracked, trackedForMedia } from '@/lib/db';
import { jellyfinPresence } from '@/lib/jellyfin';
import { linkedRoot, seasonRef } from '@/lib/anime-franchise';
import { animeIdsLoaded, firstSeason, idsOfAnilist } from '@/lib/anime-ids';
import { emptyMedia } from '@/lib/media';
export const GET = route(async (r) => {
  const id = mediaId.parse(new URL(r.url).searchParams.get('id'));
  // A later season already known to belong to a work: open the work right away.
  // A later season (or a work joined by hand) opens its work right away: known works first,
  // then manual links, then the offline id map — no AniList request needed to know it.
  if (id.startsWith('anilist:')) {
    const n = Number(id.slice('anilist:'.length));
    const ref = seasonRef(n);
    // Only when the anime id map is already loaded: a manga sheet never downloads it.
    const ids = animeIdsLoaded() ? idsOfAnilist(n) : null;
    const root =
      ref?.root.anilistId ??
      linkedRoot(n) ??
      (ids && ['TV', 'ONA'].includes(ids.type ?? '') ? firstSeason(n) : n);
    if (root !== n)
      return json({
        ...(ref?.root ?? emptyMedia(`anilist:${root}`, '', 'ANIME')),
        tags: [],
        relations: [],
        recommendations: [],
        workOf: { id: `anilist:${root}`, season: ref?.season ?? ids?.tvdbSeason ?? 1 },
        pending: true,
      });
  }
  const detail = await mediaDetail(id, r.signal, true);
  if (detail.type !== 'ANIME') return json(detail);
  // Anime: what the Jellyfin library holds for it (local index, no network).
  const tracked = trackedForMedia(detail, listTracked());
  return json({ ...detail, jellyfin: jellyfinPresence(detail, tracked?.jellyfinLink) });
});
