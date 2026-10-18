import { rakutenJson } from '@/lib/rakuten';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { getSettings } from '@/lib/settings';
import { AppError } from '@/lib/errors';
import { requireAdmin } from '@/lib/auth';
import { googleBooksJson } from '@/lib/edition-feeds';
import { metronJson } from '@/lib/metron';
import { hardcoverQuery } from '@/lib/hardcover';
const schema = z
  .object({ provider: z.enum(['googlebooks', 'metron', 'rakuten', 'hardcover']) })
  .strict();
export const POST = route(async (request) => {
  requireAdmin();
  const { provider } = await body(request, schema);
  const s = getSettings();
  if (provider === 'googlebooks') {
    if (!s.googleBooksApiKey)
      throw new AppError('PROVIDER_UNCONFIGURED', 'Provider is not configured', 409);
    const result = await googleBooksJson<{ kind?: string }>(
      'https://www.googleapis.com/books/v1/volumes?q=isbn:9780140328721&maxResults=1',
      5 * 60_000,
    );
    if (result.kind !== 'books#volumes')
      throw new AppError('PROVIDER_INVALID_RESPONSE', 'Invalid provider response', 502);
  } else if (provider === 'metron') {
    const result = await metronJson<{ results?: unknown[] }>('/series/?page=1', 5 * 60_000);
    if (!Array.isArray(result.results))
      throw new AppError('PROVIDER_INVALID_RESPONSE', 'Invalid provider response', 502);
  } else if (provider === 'hardcover') {
    const result = await hardcoverQuery<{ me?: { id: number }[] }>(
      'query BunkoTest { me { id } }',
      {},
      5 * 60_000,
    );
    if (!result.me?.length)
      throw new AppError('PROVIDER_AUTH_FAILED', 'Provider authentication failed', 502);
  } else {
    const result = await rakutenJson<{ Items?: unknown[] }>({ isbn: '9780140328721', hits: '1' });
    if (!Array.isArray(result.Items))
      throw new AppError('PROVIDER_INVALID_RESPONSE', 'Invalid provider response', 502);
  }
  return json({ ok: true, provider });
});
