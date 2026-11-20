import type { ExtensionSectionRef, TrackedMedia, UnifiedMedia, UnlinkedItem } from '@/types/shared';
import { KINDS, kindOfMedia, type Kind } from '@/domain/kinds';
import { getTracked, listTracked, statement, track } from './db';
import { AppError } from './errors';
import {
  applyJellyfinProgress,
  jellyfinConfigured,
  jellyfinIndexedSeries,
  jellyfinWorkOf,
  matchJellyfin,
} from './jellyfin';
import { kavitaSummaries } from './kavita-index';
import { applyStashProgress, stashUnlinked, stashWork } from './stash';
import { kavitaMedia } from './kavita-track';

/**
 * What the account's integrations hold that no work of the library is linked to: the inbox where
 * each item is linked to a catalog work or becomes a work of its own (a "sheet") of any kind.
 */
type Integration = UnlinkedItem['integration'];
const ignoredKey = (integration: Integration, id: string) =>
  `unlinked_ignored:${integration}:${id}`;

function ignoredIds(integration: Integration) {
  const prefix = `unlinked_ignored:${integration}:`;
  return new Set(
    (
      statement('SELECT key FROM worker_state WHERE key LIKE ?').all(`${prefix}%`) as {
        key: string;
      }[]
    ).map((r) => r.key.slice(prefix.length)),
  );
}

/** Jellyfin series and films that no followed work is linked to. */
function jellyfinUnlinked(): UnlinkedItem[] {
  if (!jellyfinConfigured()) return [];
  const linked = new Set(
    listTracked()
      .filter((t) => t.type === 'ANIME')
      .flatMap((t) => {
        const m = matchJellyfin(t.media, t.jellyfinLink);
        return m ? [m.series.id] : [];
      }),
  );
  const ignored = ignoredIds('jellyfin');
  return jellyfinIndexedSeries()
    .filter((s) => !linked.has(s.id))
    .map((s) => ({
      integration: 'jellyfin' as const,
      id: s.id,
      name: s.name,
      year: s.year,
      library: s.library ?? '',
      count: Object.values(s.seasons).reduce((n, list) => n + list.length, 0),
      coverUrl: `/api/jellyfin/image?id=${s.id}`,
      kind: (
        { anime: 'anime', series: 'series', movies: 'movies', animation: 'animation' } as const
      )[s.role === 'ignore' ? 'anime' : s.role],
      ignored: ignored.has(s.id),
    }));
}

/** Kavita series that no followed work is linked to. */
function kavitaUnlinked(): UnlinkedItem[] {
  const ignored = ignoredIds('kavita');
  return kavitaSummaries(true).map((s) => ({
    integration: 'kavita' as const,
    id: String(s.seriesId),
    name: s.name,
    year: null,
    library: s.libraryName,
    count: s.chapters,
    coverUrl: s.coverUrl,
    kind: kindOfMedia(kavitaMedia(s.seriesId)),
    ignored: ignored.has(String(s.seriesId)),
  }));
}

export function unlinkedItems(): UnlinkedItem[] {
  return [...jellyfinUnlinked(), ...stashUnlinked(ignoredIds('stash')), ...kavitaUnlinked()];
}

export function setUnlinkedIgnored(integration: Integration, id: string, ignored: boolean) {
  if (ignored)
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      ignoredKey(integration, id),
      new Date().toISOString(),
    );
  else statement('DELETE FROM worker_state WHERE key=?').run(ignoredKey(integration, id));
}

/** The work an item becomes, given the kind (and extension section) chosen for it. */
export function sheetMedia(
  base: UnifiedMedia,
  kind: Kind,
  title: string,
  year: number | null,
  section: ExtensionSectionRef | null,
  adult = false,
): UnifiedMedia {
  const def = KINDS[kind];
  if ((base.type === 'ANIME') !== (def.family === 'video'))
    throw new AppError('VALIDATION_ERROR', 'The kind must match what the item holds', 400);
  if (kind === 'extension' && !section)
    throw new AppError('VALIDATION_ERROR', 'Choose the extension section', 400);
  const { extensionSection: _drop, ...rest } = base;
  void _drop;
  return {
    ...rest,
    type: def.mediaType,
    // Reading kinds carry their format (a manga series filed as a novel becomes one).
    format: def.family === 'reading' ? (def.formats[0] ?? base.format) : base.format,
    // Only a kind other than the item's own is an override (no "Anime · Anime").
    ...(kindOfMedia(base) === kind && kind !== 'extension' ? {} : { kindOverride: kind }),
    ...(kind === 'extension' && section ? { extensionSection: section } : {}),
    title,
    year: year ?? base.year,
    // 18+ as chosen (or as the extension declares its section): the 18+ modes show it accordingly.
    adult: adult || Boolean(base.adult),
  };
}

/**
 * Follow an item as a work of its own: its sheet is made from what the integration knows, with
 * the kind, title and year chosen, and stays linked to the item (episodes, files, watched or
 * read state).
 */
export function createSheet(input: {
  integration: Integration;
  id: string;
  kind: Kind;
  title: string;
  year: number | null;
  section: ExtensionSectionRef | null;
  adult?: boolean;
}): TrackedMedia {
  if (input.integration === 'jellyfin') {
    const media = sheetMedia(
      jellyfinWorkOf(input.id),
      input.kind,
      input.title,
      input.year,
      input.section,
      input.adult,
    );
    const entry = track({ media, status: 'PLANNING' });
    statement('UPDATE tracked_media SET jellyfin_link=?, off_catalog=1 WHERE id=?').run(
      JSON.stringify({ seriesId: input.id, season: 1 }),
      entry.id,
    );
    // What was already watched in Jellyfin counts at once.
    applyJellyfinProgress();
    return getTracked(entry.id)!;
  }
  if (input.integration === 'stash') {
    const media = sheetMedia(
      stashWork(input.id),
      input.kind,
      input.title,
      input.year,
      input.section,
      input.adult,
    );
    const entry = track({ media, status: 'PLANNING' });
    statement('UPDATE tracked_media SET off_catalog=1 WHERE id=?').run(entry.id);
    applyStashProgress();
    return getTracked(entry.id)!;
  }
  const seriesId = Number(input.id);
  if (!Number.isInteger(seriesId) || seriesId <= 0)
    throw new AppError('VALIDATION_ERROR', 'Invalid Kavita series', 400);
  const media = sheetMedia(
    kavitaMedia(seriesId),
    input.kind,
    input.title,
    input.year,
    input.section,
  );
  const entry = track({ media, status: 'READING', kavitaSeriesId: seriesId });
  // Chosen by hand: automatic matching never moves this series elsewhere.
  statement(
    'UPDATE tracked_media SET kavita_series_id=?, kavita_manual=1, off_catalog=1 WHERE id=?',
  ).run(seriesId, entry.id);
  return getTracked(entry.id)!;
}
