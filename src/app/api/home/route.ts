export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { homeFeed } from '@/lib/home';
const kind = z
  .enum(['manga', 'manhwa', 'manhua', 'comic', 'lightnovel', 'webnovel', 'novel', 'book', 'anime'])
  .optional();
/** `?kind=` limits the home to one universe (and loads only it). */
export const GET = route(async (r) =>
  json(await homeFeed(kind.parse(new URL(r.url).searchParams.get('kind') ?? undefined))),
);
