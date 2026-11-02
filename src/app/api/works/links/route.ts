export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { linkedMembers, loadedAnime, prefetchNodes, setWorkLink } from '@/lib/anime-franchise';
import { normalizeAnimeWorks } from '@/lib/anime-works';
import { wakeWorker } from '@/lib/worker-events';

const anilist = z
  .string()
  .regex(/^anilist:[1-9]\d{0,9}$/)
  .transform((id) => Number(id.slice('anilist:'.length)));
/** Works joined by hand into this anime work (another series, films…). */
export const GET = route(async (r) => {
  const root = anilist.parse(new URL(r.url).searchParams.get('root'));
  const members = linkedMembers(root);
  await prefetchNodes(members, r.signal).catch(() => undefined);
  return json(members.map((id) => loadedAnime(id)).filter(Boolean));
});
/** Join a work into another (or undo it): the library merges it and lists stop showing it apart. */
export const POST = route(async (r) => {
  const input = await body(
    r,
    z.object({ root: anilist, member: anilist, joined: z.boolean() }).strict(),
  );
  setWorkLink(input.root, input.member, input.joined);
  void normalizeAnimeWorks().catch(() => undefined);
  wakeWorker();
  return json({ ok: true });
});
