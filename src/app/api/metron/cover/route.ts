export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { metronCover } from '@/lib/metron';

export const GET = route(async (request) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(request.url).searchParams.get('seriesId'));
  const image = await metronCover(id, request.signal);
  if (!image) throw new AppError('NOT_FOUND', 'Cover unavailable', 404);
  // Only the public artwork URL leaves Bunko; Metron authentication stays on the server.
  return new Response(null, {
    status: 302,
    headers: {
      Location: image,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
