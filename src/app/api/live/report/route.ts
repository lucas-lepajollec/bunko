export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { channelIdSchema as channelId, reportLiveFailure } from '@/lib/live/live';

/** The player tried every source of a channel and none played: its free streams are rechecked. */
export const POST = route(async (r) => {
  const input = await body(r, z.object({ id: channelId }).strict());
  reportLiveFailure(input.id);
  return json({ ok: true });
});
