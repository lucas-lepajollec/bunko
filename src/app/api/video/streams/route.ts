export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { episodeStreams, titleStreams } from '@/lib/video-addons';

/**
 * Streams of one episode: an anime by its season's AniList id, a series by IMDb and/or TMDB id
 * + season + episode, a film by IMDb and/or TMDB id alone.
 */
export const GET = route(async (r) => {
  const q = z
    .object({
      anilist: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      imdb: z
        .string()
        .regex(/^tt\d{5,10}$/)
        .optional(),
      tmdb: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      season: z.coerce.number().int().min(0).max(500).optional(),
      episode: z.coerce.number().int().positive().max(5000).optional(),
      lang: z.enum(['en', 'fr', 'es', 'de', 'it']).default('en'),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  if (q.anilist && q.episode)
    return json(await episodeStreams(q.anilist, q.episode, q.lang, r.signal));
  if (q.imdb || q.tmdb)
    return json(
      await titleStreams(
        { imdb: q.imdb ?? null, tmdb: q.tmdb ?? null },
        q.season !== undefined && q.episode ? { season: q.season, episode: q.episode } : null,
        q.lang,
        r.signal,
      ),
    );
  return json({ streams: [], subtitles: [], errors: [] });
});
