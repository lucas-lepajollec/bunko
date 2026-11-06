export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { channelIdSchema as channelId, liveChannel } from '@/lib/live/live';

/** One channel: its streams (through Bunko's relay), what is on and the next hours. */
export const GET = route(async (r) => {
  const p = z.object({ id: channelId }).parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await liveChannel(p.id));
});
