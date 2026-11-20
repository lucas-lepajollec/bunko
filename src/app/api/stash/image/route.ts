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
  const at = stashImagePath(id);
  if (!at) throw new AppError('NOT_FOUND', 'No picture for this Stash item', 404);
  return cachedImageResponse(r, `stash:${id}:${at}`, () =>
    fetchImage(
      endpoint(s.stashUrl, at),
      { ApiKey: s.stashApiKey },
      undefined,
      false,
      AbortSignal.timeout(15_000),
    ),
  );
});
