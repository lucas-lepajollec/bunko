import type { ExtensionSectionRef, TrackedMedia, UnifiedMedia, UnlinkedItem } from '@/types/shared';
import { KINDS, kindOfMedia, type Kind } from '@/domain/kinds';
import { getTracked, listTracked, statement, track } from './db';
import { AppError } from './errors';
import {
  applyJellyfinProgress,
  jellyfinConfigured,
  jellyfinIndexedSeries,
  jellyfinWorkOf,
  jellyfinSeriesInUse,
} from './jellyfin';
import { kavitaSummaries } from './kavita-index';
import { applyStashProgress, stashUnlinked, stashWork } from './stash';
import { kavitaMedia } from './kavita-track';
import { INTEGRATIONS, type IntegrationId } from '@/domain/integrations';

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

/**
 * What each integration holding works brings to the inbox (one entry per integration, keyed like
 * the registry in `lib/integrations.ts`): its items no work is linked to, the work an item becomes,
 * and how the new work stays linked to its item (and takes what the server says was seen).
 */
interface Inventory {
  unlinked(ignored: Set<string>): UnlinkedItem[];
  work(id: string): UnifiedMedia;
  adopt(trackedId: number, id: string): void;
  /** A work made from it starts as being read (Kavita) rather than planned. */
  status?: 'READING';
}
const kavitaSeries = (id: string) => {
  const seriesId = Number(id);
  if (!Number.isInteger(seriesId) || seriesId <= 0)
    throw new AppError('VALIDATION_ERROR', 'Invalid Kavita series', 400);
  return seriesId;
};
const INVENTORIES: Partial<Record<IntegrationId, Inventory>> = {
  jellyfin: {
    unlinked: (ignored) => {
      if (!jellyfinConfigured()) return [];
      // Every series a work holds, one per season when its seasons are separate series.
      const linked = jellyfinSeriesInUse(listTracked().filter((t) => t.type === 'ANIME'));
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
    },
    work: (id) => jellyfinWorkOf(id),
    adopt: (trackedId, id) => {
      statement('UPDATE tracked_media SET jellyfin_link=?, off_catalog=1 WHERE id=?').run(
        JSON.stringify({ seriesId: id, season: 1 }),
        trackedId,
      );
      // What was already watched in Jellyfin counts at once.
      applyJellyfinProgress();
    },
  },
  stash: {
    unlinked: (ignored) => stashUnlinked(ignored),
    work: (id) => stashWork(id),
    adopt: (trackedId) => {
      statement('UPDATE tracked_media SET off_catalog=1 WHERE id=?').run(trackedId);
      applyStashProgress();
    },
  },
  kavita: {
    unlinked: (ignored) =>
      kavitaSummaries(true).map((s) => ({
        integration: 'kavita' as const,
        id: String(s.seriesId),
        name: s.name,
        year: null,
        library: s.libraryName,
        count: s.chapters,
        coverUrl: s.coverUrl,
        kind: kindOfMedia(kavitaMedia(s.seriesId)),
        ignored: ignored.has(String(s.seriesId)),
      })),
    work: (id) => kavitaMedia(kavitaSeries(id)),
    // Chosen by hand: automatic matching never moves this series elsewhere.
    adopt: (trackedId, id) =>
      statement(
        'UPDATE tracked_media SET kavita_series_id=?, kavita_manual=1, off_catalog=1 WHERE id=?',
      ).run(kavitaSeries(id), trackedId),
    status: 'READING',
  },
};

export function unlinkedItems(): UnlinkedItem[] {
  // Video servers first, then reading ones (the registry's order).
  return INTEGRATIONS.flatMap((i) => {
    const inventory = INVENTORIES[i.id];
    return inventory ? inventory.unlinked(ignoredIds(i.id as Integration)) : [];
  }).sort((a, b) => Number(a.integration === 'kavita') - Number(b.integration === 'kavita'));
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
  const inventory = INVENTORIES[input.integration];
  if (!inventory) throw new AppError('VALIDATION_ERROR', 'Unknown integration', 400);
  const media = sheetMedia(
    inventory.work(input.id),
    input.kind,
    input.title,
    input.year,
    input.section,
    input.adult,
  );
  const entry = track({ media, status: inventory.status ?? 'PLANNING' });
  inventory.adopt(entry.id, input.id);
  return getTracked(entry.id)!;
}
