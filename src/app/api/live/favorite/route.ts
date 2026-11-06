export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { channelIdSchema as channelId, setFavorite } from '@/lib/live/live';

export const PUT = route(async (r) => {
  const input = await body(r, z.object({ id: channelId, favorite: z.boolean() }).strict());
  setFavorite(input.id, input.favorite);
  return json({ ok: true });
});
