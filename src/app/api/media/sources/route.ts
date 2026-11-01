import { listTracked, statement, trackedForMedia } from '@/lib/db';
import { linkMatchedSources } from '@/lib/tracked-sources';
import { preferredSourceLanguage } from '@/lib/source-preferences';
import { sourceServerKey } from '@/lib/source-server';
import type { SourceCandidate } from '@/types/shared';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route, sse } from '@/lib/api';
import { z } from 'zod';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { scanMatchingSources } from '@/lib/matching-scan';
import { matchingSources } from '@/lib/suwayomi';
import { errorCode, errorDetail } from '@/lib/errors';
/** Streams, source by source, the Suwayomi entries that correspond to a catalogue title. */
export const GET = route(async (r) => {
  const { id, q, link } = z
    .object({
      id: mediaId,
      q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\u0000-\u001f\u007f]+$/)
        .optional(),
      link: z.literal('1').optional(),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  const media = await mediaDetail(id, r.signal);
  const tracked = trackedForMedia(media, listTracked());
  // A work whose sources were all removed by hand is only relinked on an explicit search.
  const cleared =
    tracked &&
    statement('SELECT 1 FROM worker_state WHERE key=?').get(`source_manual_empty:${tracked.id}`);
  if (tracked && cleared && link === '1')
    statement('DELETE FROM worker_state WHERE key=?').run(`source_manual_empty:${tracked.id}`);
  const snapshot =
    tracked && !tracked.sources.length && q === undefined && (!cleared || link === '1')
      ? tracked
      : null;
  const namespace = sourceServerKey();
  const language = preferredSourceLanguage();
  let expected = snapshot?.sources ?? [];
  const found: SourceCandidate[] = [];
  return sse(r, async (send, signal) => {
    const list = media.type === 'MANGA' ? await matchingSources(signal) : [];
    send('sources', { sources: list });
    await scanMatchingSources(
      list,
      media,
      signal,
      (source, candidates, durationMs) => {
        send('match', { source, candidates, durationMs });
        found.push(...candidates);
        if (snapshot && !signal.aborted) {
          const linked = linkMatchedSources(snapshot, found, expected, namespace, language);
          if (linked) {
            expected = linked.sources;
            send('linked', { trackedId: linked.id });
          }
        }
      },
      (source, e) => send('source_error', { source, code: errorCode(e), detail: errorDetail(e) }),
      q,
    );
    send('done', { completed: list.length });
  });
});
