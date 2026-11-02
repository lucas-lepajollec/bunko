export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { playbackInfo, reportPlayback } from '@/lib/jellyfin-play';

const itemId = z.string().regex(/^[0-9a-f]{32}$/i);
/** Streams (audio, subtitles), duration and resume point of a Jellyfin episode. */
export const GET = route(async (r) =>
  json(await playbackInfo(itemId.parse(new URL(r.url).searchParams.get('item')), r.signal)),
);
/** Playback position: saved for resume, past 90 % the episode is marked played in Jellyfin. */
export const POST = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        itemId,
        playSessionId: z.string().regex(/^[0-9a-f]{32}$/i),
        positionMs: z.number().min(0).max(1e9),
        durationMs: z.number().min(0).max(1e9).nullable(),
        event: z.enum(['progress', 'stop']),
      })
      .strict(),
  );
  return json(await reportPlayback(input, r.signal));
});
