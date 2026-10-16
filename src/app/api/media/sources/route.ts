export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route, sse } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { matchOnSource } from '@/lib/matching';
import { sources } from '@/lib/suwayomi';
import { errorCode } from '@/lib/errors';
/** Streams, source by source, the Suwayomi entries that correspond to a catalogue title. */
export const GET = route(async (r) => {
  const id = mediaId.parse(new URL(r.url).searchParams.get('id'));
  const media = await mediaDetail(id, r.signal);
  return sse(r, async (send, signal) => {
    const list = media.type === 'MANGA' ? await sources(signal) : [];
    send('sources', { sources: list });
    await Promise.allSettled(
      list.map(async (source) => {
        const start = Date.now();
        try {
          const candidates = await matchOnSource(source, media, signal);
          send('match', { source, candidates, durationMs: Date.now() - start });
        } catch (e) {
          send('source_error', { source, code: errorCode(e) });
        }
      }),
    );
    send('done', { completed: list.length });
  });
});
