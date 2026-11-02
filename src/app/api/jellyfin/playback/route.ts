export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { playbackInfo, reportPlayback } from '@/lib/jellyfin-play';

const itemId = z.string().regex(/^[0-9a-f]{32}$/i);
/** How to play a Jellyfin episode for this browser (device profile from the player). */
export const PUT = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        itemId,
        profile: z.record(z.string(), z.unknown()),
        maxBitrate: z.number().int().min(100_000).max(400_000_000),
        startMs: z.number().min(0).max(1e9).optional(),
        audioIndex: z.number().int().min(0).max(999).nullable().optional(),
        subtitleIndex: z.number().int().min(-1).max(999).nullable().optional(),
      })
      .strict(),
  );
  const { itemId: id, ...options } = input;
  return json(await playbackInfo(id, options, r.signal));
});
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
