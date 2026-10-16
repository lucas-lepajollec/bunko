export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { kavitaHeaders, kavitaCoverEndpoint } from '@/lib/kavita-client';
import { cachedImageResponse, fetchImage, kavitaImageKey } from '@/lib/image-cache';
export const GET = route(async (r) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(r.url).searchParams.get('seriesId'));
  return cachedImageResponse(r, kavitaImageKey(id), async () => {
    const signal = AbortSignal.timeout(15_000);
    return fetchImage(
      kavitaCoverEndpoint(id),
      await kavitaHeaders(signal),
      undefined,
      false,
      signal,
    );
  });
});
