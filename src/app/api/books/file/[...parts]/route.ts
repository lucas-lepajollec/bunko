export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route } from '@/lib/api';
import { bookResource } from '@/lib/books';
import { AppError } from '@/lib/errors';
import { mediaId } from '@/lib/validation';

/**
 * `/api/books/file/<media>/<file>` is the whole book file; anything after it is a path inside
 * an EPUB, so the book's own relative links (styles, images, chapters) resolve naturally.
 */
export const GET = route(async (r) => {
  const parts = new URL(r.url).pathname.split('/').slice(4);
  if (parts.length < 2) throw new AppError('NOT_FOUND', 'Not found', 404);
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    throw new AppError('NOT_FOUND', 'Not found', 404);
  }
  const [media, key, ...inner] = decoded;
  if (!/^[\w-]{16}$/.test(key)) throw new AppError('NOT_FOUND', 'Not found', 404);
  return bookResource(r, mediaId.parse(media), key, inner.join('/'));
});
