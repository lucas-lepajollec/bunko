import { eachConcurrent } from '@/lib/concurrency';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, route, sse } from '@/lib/api';
import { sources, searchSource } from '@/lib/suwayomi';
import { errorCode, errorDetail } from '@/lib/errors';
export const POST = route(async (r) => {
  const { pages } = await body(r, z.object({ pages: z.number().int().min(1).max(50).default(5) }));
  return sse(r, async (send, signal) => {
    const list = await sources(signal);
    send('sources', { sources: list });
    await eachConcurrent(
      list,
      6,
      async (source) => {
        try {
          for (let page = 1; page <= pages && !signal.aborted; page++) {
            const result = await searchSource(source, '', signal, page, 'POPULAR');
            send('source_result', result);
            if (!result.hasNextPage) break;
          }
        } catch (e) {
          send('source_error', { source, code: errorCode(e), detail: errorDetail(e) });
        }
      },
      signal,
    );
    send('done', { completed: list.length });
  });
});
