import { listTracked, trackedForMedia } from '@/lib/db';
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
  const { id, q } = z
    .object({
      id: mediaId,
      q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\u0000-\u001f\u007f]+$/)
        .optional(),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  const media = await mediaDetail(id, r.signal);
  const tracked = trackedForMedia(media, listTracked());
  const snapshot = tracked && !tracked.sources.length && q === undefined ? tracked : null;
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
