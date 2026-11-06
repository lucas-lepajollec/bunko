export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { bookManifest } from '@/lib/books';
import { mediaId } from '@/lib/validation';

export const GET = route(async (r) => {
  const p = z
    .object({ media: mediaId, file: z.string().regex(/^[\w-]{16}$/) })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await bookManifest(p.media, p.file, r.signal));
});
