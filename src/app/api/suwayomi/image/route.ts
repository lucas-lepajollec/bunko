import { route } from '@/lib/api';
import { imagePath } from '@/lib/images';
import { getSettings } from '@/lib/settings';
import { suwayomiHeaders } from '@/lib/suwayomi';
import { endpoint } from '@/lib/http';
import { AppError } from '@/lib/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (r) => {
  const path = imagePath(new URL(r.url).searchParams.get('path') ?? '');
  const signal = AbortSignal.any([r.signal, AbortSignal.timeout(15_000)]);
  const response = await fetch(endpoint(getSettings().suwayomiUrl, path), {
    headers: suwayomiHeaders(),
    signal,
    redirect: 'error',
  });
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  const max = 10 * 1024 * 1024;
  if (
    !response.ok ||
    !response.body ||
    !/^image\/(?:jpeg|png|webp|gif|avif|x-icon|vnd\.microsoft\.icon)$/.test(mime) ||
    Number(response.headers.get('content-length')) > max
  ) {
    await response.body?.cancel();
    throw new AppError('IMAGE_UNAVAILABLE', 'Upstream image unavailable', 502);
  }
  let size = 0;
  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, output) {
        size += chunk.byteLength;
        if (size > max) throw new Error('Image size limit exceeded');
        output.enqueue(chunk);
      },
    }),
  );
  return new Response(stream, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
