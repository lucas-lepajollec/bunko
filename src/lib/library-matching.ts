import { visibleTracked } from './adult';
import { db, getTracked, listTracked, sameMedia, statement } from './db';
import { activeSourceMatch } from './source-match-state';
import { sourceServerKey } from './source-server';
import { wakeWorker } from './worker-events';
import { coverContext } from './cover-state';
import { indexedSeriesById } from './kavita-index';
import { preferredSourceLanguage } from './source-preferences';
import type { TrackedMedia } from '@/types/shared';

const marker = (id: number) => `library_catalog_match:${id}`;

export function libraryMatchRequest(id: number) {
  return statement('SELECT value FROM worker_state WHERE key=?').get(marker(id)) as
    { value: string } | undefined;
}
export function finishLibraryMatch(id: number, value: string) {
  statement('DELETE FROM worker_state WHERE key=? AND value=?').run(marker(id), value);
}

/** Reuse the durable source worker; a button never launches an unbounded HTTP fan-out. */
export function requestLibraryMatching(ids?: number[]) {
  const selected = ids ? new Set(ids) : null;
  const active = activeSourceMatch()?.id;
  const entries = visibleTracked(listTracked()).filter(
    (entry) =>
      entry.type === 'MANGA' &&
      !entry.sources.length &&
      entry.id !== active &&
      (!selected || selected.has(entry.id)),
  );
  const namespace = sourceServerKey();
  db().transaction(() => {
    for (const entry of entries) {
      statement(
        'UPDATE tracked_media SET source_match_at=NULL WHERE id=? AND json_array_length(sources_json)=0',
      ).run(entry.id);
      statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
        marker(entry.id),
        JSON.stringify({ mediaId: entry.media.id, namespace, language: preferredSourceLanguage() }),
      );
    }
  })();
  if (entries.length) wakeWorker();
  return { queued: entries.length };
}

/** Only a requested, unambiguous automatic Kavita match may replace an off-catalog identity. */
export async function resolveQueuedCatalog(
  entry: TrackedMedia,
  signal?: AbortSignal,
  ownsLease = () => true,
) {
  const row = libraryMatchRequest(entry.id);
  if (!row) return entry;
  const request = JSON.parse(row.value) as { mediaId: string; namespace: string };
  const seriesId = entry.kavitaSeriesId ?? entry.media.kavitaSeriesId;
  const series = seriesId ? indexedSeriesById(seriesId) : undefined;
  try {
    if (
      request.mediaId !== entry.media.id ||
      request.namespace !== sourceServerKey() ||
      !series ||
      entry.identity !== 'off-catalog'
    )
      return entry;
    if (
      (
        statement('SELECT off_catalog FROM tracked_media WHERE id=?').get(entry.id) as {
          off_catalog: number;
        }
      ).off_catalog
    )
      return entry;
    const { catalogMatch } = await import('./kavita-track');
    // Catalog providers coalesce loads: bound this consumer's wait without cancelling other readers.
    const { waitForSignal } = await import('./concurrency');
    const lookupSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5_000)]);
    const media = await waitForSignal(catalogMatch(series, lookupSignal, 0.98), lookupSignal);
    if (!media || signal?.aborted || !ownsLease()) return entry;
    db().transaction(() => {
      const current = getTracked(entry.id);
      if (
        !current ||
        current.media.id !== entry.media.id ||
        current.sources.length ||
        current.identity !== entry.identity ||
        (current.kavitaSeriesId ?? current.media.kavitaSeriesId) !== seriesId ||
        sourceServerKey() !== request.namespace ||
        !ownsLease()
      )
        return;
      if (
        (
          statement('SELECT off_catalog FROM tracked_media WHERE id=?').get(entry.id) as {
            off_catalog: number;
          }
        ).off_catalog
      )
        return;
      if (listTracked().some((other) => other.id !== entry.id && sameMedia(other.media, media)))
        return;
      // A second independent local reading identity must be reviewed instead of merged by guessing.
      if (
        statement('SELECT 1 FROM local_reader_chapters WHERE media_id IN (?,?) LIMIT 1').get(
          media.id,
          `@volume:${media.id}`,
        )
      )
        return;
      const oldId = current.media.id;
      statement(`INSERT INTO reader_progress(media_id,chapter_id,number,page,page_count,updated_at)
        SELECT ?,chapter_id,number,page,page_count,updated_at FROM reader_progress WHERE media_id=?
        ON CONFLICT(media_id,chapter_id) DO UPDATE SET number=excluded.number,page=excluded.page,
        page_count=excluded.page_count,updated_at=excluded.updated_at WHERE excluded.updated_at>reader_progress.updated_at`).run(
        media.id,
        oldId,
      );
      statement('DELETE FROM reader_progress WHERE media_id=?').run(oldId);
      statement(
        `UPDATE local_reader_chapters SET media_id=CASE WHEN media_id=? THEN ? ELSE ? END WHERE media_id IN (?,?)`,
      ).run(oldId, media.id, `@volume:${media.id}`, oldId, `@volume:${oldId}`);
      const canonical = { ...media, trackedId: current.id, kavitaSeriesId: series.seriesId };
      statement('UPDATE imported_chapters SET media_json=? WHERE tracked_id=?').run(
        JSON.stringify(canonical),
        current.id,
      );
      // This is the same owned work receiving metadata: its validated pixels stay pinned.
      const oldContext = coverContext(oldId, current.identity, current.coverChoice);
      const newContext = coverContext(media.id, 'catalog', current.coverChoice);
      for (const table of ['stored_covers', 'resolved_covers', 'kavita_cover_status'])
        statement(`UPDATE ${table} SET context=? WHERE tracked_id=? AND context=?`).run(
          newContext,
          current.id,
          oldContext,
        );
      statement(
        'UPDATE tracked_media SET media_json=?,anilist_id=?,mangadex_id=?,title=?,type=?,kavita_series_id=?,source_match_at=NULL WHERE id=?',
      ).run(
        JSON.stringify(canonical),
        media.anilistId,
        media.mangadexId,
        media.title,
        media.type,
        series.seriesId,
        current.id,
      );
    })();
    return getTracked(entry.id) ?? entry;
  } finally {
    if (!signal?.aborted && ownsLease()) finishLibraryMatch(entry.id, row.value);
  }
}
