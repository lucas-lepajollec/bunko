export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { kavitaHeaders, kavitaCoverEndpoint } from '@/lib/kavita-client';
import { cachedImage, fetchImage, imageResponse, kavitaImageKey } from '@/lib/image-cache';
export const GET = route(async (r) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(r.url).searchParams.get('seriesId'));
  const image = await cachedImage(kavitaImageKey(id), async () => {
    const signal = AbortSignal.timeout(15_000);
    return fetchImage(
      kavitaCoverEndpoint(id),
      await kavitaHeaders(signal),
      undefined,
      false,
      signal,
    );
  });
  return imageResponse(r, image);
});
