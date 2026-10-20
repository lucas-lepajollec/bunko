export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { metronCover, metronScope } from '@/lib/metron';
import { cachedImageResponse, fetchImage } from '@/lib/image-cache';
import { tenantSignal } from '@/lib/tenant-lifecycle';
import { waitForSignal } from '@/lib/concurrency';

export const GET = route(async (request) => {
  request.signal.throwIfAborted();
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(request.url).searchParams.get('seriesId'));
  // Serve bytes on this origin: browser fetch must not depend on the CDN's CORS policy.
  // The coalesced cache load can finish for other viewers after this request is abandoned.
  const pending = cachedImageResponse(request, `metron:${metronScope()}:cover:${id}`, async () => {
    const image = await metronCover(id, tenantSignal());
    if (!image) throw new AppError('NOT_FOUND', 'Cover unavailable', 404);
    // No Metron credentials are sent to the allowlisted public image host.
    return fetchImage(
      image,
      {},
      undefined,
      false,
      AbortSignal.any([tenantSignal(), AbortSignal.timeout(15_000)]),
    );
  });
  return waitForSignal(pending, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]));
});
