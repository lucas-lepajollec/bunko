export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { bookFiles } from '@/lib/books';
import { mediaId } from '@/lib/validation';

/** The work's EPUB and PDF files in the library, with the reading position in each. */
export const GET = route(async (r) => {
  const p = z.object({ media: mediaId }).parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await bookFiles(p.media, r.signal));
});
