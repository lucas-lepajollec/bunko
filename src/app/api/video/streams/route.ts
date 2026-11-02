export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { episodeStreams } from '@/lib/video-addons';

/** Streams of one anime episode (the season's AniList id and its episode number). */
export const GET = route(async (r) => {
  const q = z
    .object({
      anilist: z.coerce.number().int().positive().max(2_147_483_647),
      episode: z.coerce.number().int().positive().max(5000),
      lang: z.enum(['en', 'fr', 'es', 'de', 'it']).default('en'),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await episodeStreams(q.anilist, q.episode, q.lang, r.signal));
});
