export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import {
  loadedAnime,
  prefetchNodes,
  setPartLink,
  setWorkLink,
  workParts,
} from '@/lib/anime-franchise';
import { mediaPreview } from '@/lib/media-preview';
import { idsOfAnilist } from '@/lib/anime-ids';
import { normalizeAnimeWorks } from '@/lib/anime-works';
import { wakeWorker } from '@/lib/worker-events';

/** Catalog ids a work can be joined by, any kind (anime, series, films, manga, books…). */
const workId = z
  .string()
  .regex(
    /^(anilist|tmdbtv|tmdbmovie|mangadex|mangaupdates|openlibrary|hardcover|metron):[\w-]{1,100}$/,
  );
/** An AniList anime (the offline anime map knows it): two of them merge as seasons. */
const isAnime = (id: number | null) => id !== null && idsOfAnilist(id) !== null;
const anilistOf = (id: string) => (id.startsWith('anilist:') ? Number(id.slice(8)) : null);
/** Works joined by hand into this work (another series, films, a film saga…). */
export const GET = route(async (r) => {
  const root = workId.parse(new URL(r.url).searchParams.get('root'));
  const ids = workParts(root);
  const anime = ids.map(anilistOf).filter((id): id is number => id !== null);
  await prefetchNodes(anime, r.signal).catch(() => undefined);
  const { mediaDetail } = await import('@/lib/catalog');
  const parts = await Promise.all(
    ids.map(async (id) => {
      const a = anilistOf(id);
      if (a) return loadedAnime(a);
      return mediaPreview(id) ?? (await mediaDetail(id, r.signal).catch(() => null)) ?? null;
    }),
  );
  return json(parts.filter(Boolean));
});
/** Join a work into another (or undo it): lists stop showing it apart, its sheet lists it. */
export const POST = route(async (r) => {
  const input = await body(
    r,
    z.object({ root: workId, member: workId, joined: z.boolean() }).strict(),
  );
  const root = anilistOf(input.root);
  const member = anilistOf(input.member);
  // Two anime: seasons merged into one sheet (the deeper link).
  if (isAnime(root) && isAnime(member)) {
    setWorkLink(root!, member!, input.joined);
    void normalizeAnimeWorks().catch(() => undefined);
  } else setPartLink(input.root, input.member, input.joined);
  wakeWorker();
  return json({ ok: true });
});
