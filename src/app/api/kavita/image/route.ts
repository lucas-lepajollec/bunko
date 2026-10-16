export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { kavitaHeaders } from '@/lib/kavita-client';
import { getSettings } from '@/lib/settings';
import { endpoint } from '@/lib/http';
import { boundedBuffer } from '@/lib/chapter-pages';
import { AppError } from '@/lib/errors';
export const GET = route(async (r) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(r.url).searchParams.get('seriesId'));
  const signal = AbortSignal.any([r.signal, AbortSignal.timeout(15_000)]);
  const response = await fetch(
    endpoint(getSettings().kavitaUrl, `/api/Image/series-cover?seriesId=${id}`),
    { headers: await kavitaHeaders(signal), signal, redirect: 'error' },
  );
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(type)) {
    await response.body?.cancel();
    throw new AppError('INVALID_IMAGE', 'Kavita cover is not an image', 502);
  }
  const bytes = await boundedBuffer(response, 15 * 1024 * 1024);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
