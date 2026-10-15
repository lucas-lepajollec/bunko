export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route, sse } from '@/lib/api';
import { searchParams } from '@/lib/validation';
import { sources, searchSource } from '@/lib/suwayomi';
import { errorCode } from '@/lib/errors';
export const GET = route((r) => {
  const { q } = searchParams.parse(Object.fromEntries(new URL(r.url).searchParams));
  return sse(r, async (send, signal) => {
    const list = await sources(signal);
    send('sources', { sources: list });
    await Promise.allSettled(
      list.map(async (source) => {
        try {
          send('source_result', await searchSource(source, q, signal));
        } catch (e) {
          send('source_error', { source, code: errorCode(e) });
        }
      }),
    );
    send('done', { completed: list.length });
  });
});
