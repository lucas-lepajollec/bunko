export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { tmdbConfigured, tmdbKeywords } from '@/lib/tmdb';

/** TMDB keywords matching a word: the catalog's tags for series and films. */
export const GET = route(async (r) => {
  const { q } = z
    .object({ q: z.string().trim().min(2).max(60) })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(tmdbConfigured() ? await tmdbKeywords(q) : []);
});
