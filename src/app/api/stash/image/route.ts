export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';
import { AppError } from '@/lib/errors';
import { cachedImageResponse, fetchImage } from '@/lib/image-cache';
import { stashImagePath } from '@/lib/stash';

/** Screenshot of a Stash scene or cover of a group (the API key stays on the server). */
export const GET = route(async (r) => {
  const id = z
    .string()
    .regex(/^[gs]\d{1,12}$/)
    .parse(new URL(r.url).searchParams.get('id'));
  const s = getSettings();
  if (!s.stashUrl || !s.stashApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Stash is not configured', 409);
  return cachedImageResponse(r, `stash:${id}`, async () => {
    const signal = AbortSignal.timeout(15_000);
    try {
      return await fetchImage(
        endpoint(s.stashUrl, stashImagePath(id)),
        { ApiKey: s.stashApiKey },
        undefined,
        false,
        signal,
      );
    } catch (error) {
      // Stash before 0.27 names groups "movies".
      if (!id.startsWith('g')) throw error;
      return fetchImage(
        endpoint(s.stashUrl, stashImagePath(id, 'movies')),
        { ApiKey: s.stashApiKey },
        undefined,
        false,
        AbortSignal.timeout(15_000),
      );
    }
  });
});
