export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';
import { AppError } from '@/lib/errors';
import { cachedImageResponse, fetchImage } from '@/lib/image-cache';

/** Poster of a Jellyfin series (the API key stays on the server). */
export const GET = route(async (r) => {
  const id = z
    .string()
    .regex(/^[0-9a-f]{32}$/i)
    .parse(new URL(r.url).searchParams.get('id'));
  const s = getSettings();
  if (!s.jellyfinUrl || !s.jellyfinApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Jellyfin is not configured', 409);
  return cachedImageResponse(r, `jellyfin:${id}`, async () => {
    const signal = AbortSignal.timeout(15_000);
    return fetchImage(
      endpoint(s.jellyfinUrl, `/Items/${id}/Images/Primary?maxWidth=600&quality=90`),
      { 'X-Emby-Token': s.jellyfinApiKey },
      undefined,
      false,
      signal,
    );
  });
});
