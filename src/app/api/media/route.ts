export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { listTracked, trackedForMedia } from '@/lib/db';
import { jellyfinExtraSeasons, jellyfinPresence } from '@/lib/jellyfin';
import { linkedRoot, seasonRef } from '@/lib/anime-franchise';
import { animeIdsLoaded, firstSeason, idsOfAnilist } from '@/lib/anime-ids';
import { emptyMedia } from '@/lib/media';
import { withLiveInfo } from '@/lib/work-info';
import { INTEGRATION_MODULES } from '@/lib/integrations';
import type { MediaDetail } from '@/types/shared';
import { stashConfigured, stashKeyOf, stashWebUrl } from '@/lib/stash';
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
  const own = await mediaDetail(id, r.signal, true);
  // A work of one's own taking its facts from a catalog work shows that work's
  // recommendations and universe (its own episodes and links stay).
  const from = own.metadataFrom?.id;
  const detail = from
    ? withLiveInfo(own, await mediaDetail(from, r.signal, true).catch(() => null))
    : own;
  if (detail.type !== 'ANIME') return json(detail);
  // Anime: what the Jellyfin library holds for it (local index, no network).
  const tracked = trackedForMedia(detail, listTracked());
  // The Stash item holding it (a work made from Stash, or linked by hand).
  const stashKey = tracked
    ? stashKeyOf(tracked)
    : detail.id.startsWith('stash:')
      ? detail.id.slice('stash:'.length)
      : null;
  const jellyfin = jellyfinPresence(detail, tracked?.jellyfinLink);
  const extras = jellyfinExtraSeasons(jellyfin, detail.video, tracked?.jellyfinLink);
  const withPresence: MediaDetail = {
    ...detail,
    jellyfin,
    ...(extras.length ? { jellyfinExtras: extras } : {}),
    stash: stashKey && stashConfigured() ? { url: stashWebUrl(stashKey) } : null,
  };
  // "Open in…": every video service holding the work, from the integration registry.
  const openIn = INTEGRATION_MODULES.filter((m) => m.category === 'video' && m.openIn).flatMap(
    (m) => {
      const url = m.openIn!(withPresence, tracked);
      return url ? [{ integration: m.id, url }] : [];
    },
  );
  return json({ ...withPresence, openIn });
});
