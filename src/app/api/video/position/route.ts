export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { saveVideoPosition, videoPosition } from '@/lib/video-positions';

/** `anilist:21:3`, `tt0944947:1:2`, `tmdb:1399:1:2`, `tt0111161`… */
const key = z
  .string()
  .max(80)
  .regex(/^[\w.:-]+$/);

export const GET = route(async (r) => {
  const k = key.parse(new URL(r.url).searchParams.get('key'));
  return json({ seconds: videoPosition(k) });
});

export const PUT = route(async (r) => {
  const m = await body(
    r,
    z.object({
      key,
      seconds: z.number().min(0).max(86_400).nullable(),
      duration: z.number().min(0).max(86_400).nullable().optional(),
    }),
  );
  saveVideoPosition(m.key, m.seconds, m.duration ?? null);
  return json({ ok: true });
});
