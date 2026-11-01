import { z } from 'zod';
import { db, listTracked } from './db';
import { getSettings } from './settings';
import { graphql } from './suwayomi';

/**
 * Reading progress kept by Suwayomi (its web UI, or Mihon/Tachiyomi clients synced to it): the
 * highest chapter marked read among a work's linked sources. Like Kavita progress, it only moves
 * forward and never lowers what Bunko's own reader recorded.
 */
export async function refreshSuwayomiProgress(signal?: AbortSignal) {
  if (!getSettings().suwayomiUrl) return;
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  const queue = listTracked().filter((t) => t.type === 'MANGA' && t.sources.length);
  const chapters = z.object({
    manga: z
      .object({
        chapters: z.object({
          nodes: z.array(z.object({ chapterNumber: z.number(), isRead: z.boolean() })),
        }),
      })
      .nullable(),
  });
  await Promise.allSettled(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length && !bounded.aborted) {
        const tracked = queue.shift()!;
        let read = 0;
        let checked = false;
        for (const source of tracked.sources) {
          try {
            const result = chapters.parse(
              await graphql(
                'query($id: Int!) { manga(id: $id) { chapters { nodes { chapterNumber isRead } } } }',
                { id: source.suwayomiMangaId },
                6000,
                bounded,
              ),
            );
            checked = true;
            for (const c of result.manga?.chapters.nodes ?? [])
              if (c.isRead && c.chapterNumber >= 0) read = Math.max(read, c.chapterNumber);
          } catch {
            /* Keep the last known progress for this source. */
          }
        }
        if (!checked || bounded.aborted) continue;
        db()
          .prepare(
            'UPDATE tracked_media SET last_read=CASE WHEN ?>0 THEN MAX(COALESCE(last_read,0),?) ELSE last_read END,progress_checked=1 WHERE id=?',
          )
          .run(read, read, tracked.id);
      }
    }),
  );
}

/** Bunko's reader finished a source chapter: mark it read in Suwayomi too (best effort). */
export async function markReadInSuwayomi(chapterId: number) {
  if (chapterId <= 0 || getSettings().progressSource !== 'suwayomi') return;
  try {
    await graphql(
      'mutation($id: Int!) { updateChapter(input: { id: $id, patch: { isRead: true } }) { chapter { id } } }',
      { id: chapterId },
      6000,
    );
  } catch {
    /* Bunko keeps its own position; Suwayomi catches up on the next read. */
  }
}
