export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { episodeStreams, titleStreams } from '@/lib/video-addons';
import { extensionStreams } from '@/lib/extension-catalog';

/**
 * Streams of one episode: an anime by its season's AniList id, a series by IMDb and/or TMDB id
 * + season + episode, a film by IMDb and/or TMDB id alone, or a generic catalog work by its
 * Bunko extension id (`ext:<addon>:<meta>`).
 */
export const GET = route(async (r) => {
  const q = z
    .object({
      ext: z
        .string()
        .max(800)
        .regex(/^ext:[0-9a-f]{12}:[A-Za-z0-9_-]+$/)
        .optional(),
      anilist: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      imdb: z
        .string()
        .regex(/^tt\d{5,10}$/)
        .optional(),
      tmdb: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      season: z.coerce.number().int().min(0).max(500).optional(),
      episode: z.coerce.number().int().positive().max(5000).optional(),
      film: z.enum(['0', '1']).optional(),
      lang: z.enum(['en', 'fr', 'es', 'de', 'it']).default('en'),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  if (q.ext) return json(await extensionStreams(q.ext, q.lang, q.episode, r.signal, q.season));
  if (q.anilist && q.episode)
    return json(await episodeStreams(q.anilist, q.episode, q.lang, r.signal, q.film === '1'));
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
