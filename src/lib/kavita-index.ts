import { mediaVisibility } from './adult';
import { wakeWorker } from './worker-events';
import { z } from 'zod';
import { db, statement, writeVersion } from './db';
import { getSettings } from './settings';
import { emptyMedia, normalizeTitle } from './media';
import { kavitaJson } from './kavita-client';
import { resolveLibraryFolder, writableFolder } from './library-paths';
import { eachConcurrent } from './concurrency';
import type {
  KavitaIndexStatus,
  KavitaLibrary,
  KavitaPresence,
  KavitaSeriesSummary,
  UnifiedMedia,
} from '@/types/shared';
import { AppError } from './errors';
import { suggestedLibraryKind } from './library-kinds';
const seriesSchema = z.object({
  id: z.number().int().positive(),
  libraryId: z.number().int().positive(),
  name: z.string().nullable().optional(),
  localizedName: z.string().nullable().optional(),
  originalName: z.string().nullable().optional(),
  sortName: z.string().nullable().optional(),
  folderPath: z.string().nullable().optional(),
  lowestFolderPath: z.string().nullable().optional(),
});
export interface IndexedSeries {
  adult?: boolean;
  seriesId: number;
  libraryId: number;
  libraryName: string;
  name: string;
  names: string[];
  folder: string | null;
  numbers: number[];
  summary?: string | null;
  genres?: string[];
  kind?: import('@/types/shared').LibraryKind;
  completed?: boolean;
}
let seriesSnapshot:
  | {
      version: number;
      entries: IndexedSeries[];
      ids: Map<number, IndexedSeries>;
      names: Map<string, IndexedSeries[]>;
    }
  | undefined;
function seriesIndex() {
  const version = writeVersion('series');
  if (seriesSnapshot?.version === version) return seriesSnapshot;
  const entries = (
    statement('SELECT payload FROM kavita_series ORDER BY series_id').all() as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as IndexedSeries);
  const names = new Map<string, IndexedSeries[]>();
  for (const s of entries)
    for (const name of new Set(s.names.map(normalizeTitle))) {
      const hits = names.get(name) ?? [];
      hits.push(s);
      names.set(name, hits);
    }
  const snapshot = { version, entries, ids: new Map(entries.map((s) => [s.seriesId, s])), names };
  if (!db().inTransaction) seriesSnapshot = snapshot;
  return snapshot;
}
export function indexedSeries(): IndexedSeries[] {
  return seriesIndex().entries;
}
export function indexedSeriesById(id: number): IndexedSeries | null {
  return seriesIndex().ids.get(id) ?? null;
}
type MatchMedia = Pick<UnifiedMedia, 'title' | 'altTitles' | 'kavitaSeriesId'> &
  Partial<Pick<UnifiedMedia, 'id' | 'anilistId' | 'mangadexId' | 'type'>>;
let linkage:
  | {
      version: number;
      ids: Map<string, Link>;
      anilist: Map<number, Link>;
      mangadex: Map<string, Link>;
    }
  | undefined;
type Link = { kavita_series_id: number | null; kavita_manual: number };
/** Capture an indexed resolver once per catalog/library operation. */
export function kavitaMatcher() {
  const version = writeVersion('linkage');
  let links = linkage;
  if (links?.version !== version) {
    const ids = new Map<string, Link>();
    const anilist = new Map<number, Link>();
    const mangadex = new Map<string, Link>();
    const rows = statement(
      "SELECT media_json ->> '$.id' AS identity,anilist_id,mangadex_id,kavita_series_id,kavita_manual FROM tracked_media",
    ).all() as (Link & {
      identity: string;
      anilist_id: number | null;
      mangadex_id: string | null;
    })[];
    for (const r of rows) {
      ids.set(r.identity, r);
      if (r.anilist_id !== null) anilist.set(r.anilist_id, r);
      if (r.mangadex_id !== null) mangadex.set(r.mangadex_id, r);
    }
    links = { version, ids, anilist, mangadex };
    if (!db().inTransaction) linkage = links;
  }
  const index = seriesIndex();
  return (media: MatchMedia, linkedId?: number | null): IndexedSeries | null => {
    const row = media.id
      ? (links.ids.get(media.id) ??
        links.anilist.get(media.anilistId ?? -1) ??
        links.mangadex.get(media.mangadexId ?? ''))
      : undefined;
    if (row?.kavita_manual)
      return row.kavita_series_id === null ? null : (index.ids.get(row.kavita_series_id) ?? null);
    if (linkedId === undefined) linkedId = row?.kavita_series_id;
    if (linkedId != null) return index.ids.get(linkedId) ?? null;
    if (media.type === 'ANIME') return null;
    const hits = new Set(
      [media.title, ...(media.altTitles ?? [])]
        .filter((n): n is string => typeof n === 'string')
        .flatMap((n) => index.names.get(normalizeTitle(n)) ?? []),
    );
    return hits.size === 1 ? [...hits][0] : null;
  };
}
export function matchKavita(media: MatchMedia, linkedId?: number | null): IndexedSeries | null {
  return kavitaMatcher()(media, linkedId);
}
export function seriesUrl(series: Pick<IndexedSeries, 'libraryId' | 'seriesId'>) {
  const url = getSettings().kavitaUrl.replace(/\/+$/, '');
  return url ? `${url}/library/${series.libraryId}/series/${series.seriesId}` : null;
}
export function kavitaPresence(
  series: IndexedSeries | null,
  baseUrl?: string,
): KavitaPresence | null {
  return series
    ? {
        seriesId: series.seriesId,
        libraryId: series.libraryId,
        libraryName: series.libraryName,
        chapters: series.numbers.length,
        url:
          baseUrl === undefined
            ? seriesUrl(series)
            : baseUrl
              ? `${baseUrl}/library/${series.libraryId}/series/${series.seriesId}`
              : null,
      }
    : null;
}
export function withKavita<T extends UnifiedMedia>(
  media: T,
  linkedId?: number | null,
  resolve = matchKavita,
  baseUrl?: string,
): T {
  const match = resolve(media, linkedId);
  return {
    ...media,
    adult: Boolean(media.adult || match?.adult),
    kavita: kavitaPresence(match, baseUrl),
    kavitaSeriesId: match?.seriesId ?? linkedId ?? null,
  };
}
export function kavitaSummaries(unmatched = false, query = ''): KavitaSeriesSummary[] {
  const tracked = db()
    .prepare('SELECT id,kavita_series_id,media_json FROM tracked_media')
    .all() as { id: number; kavita_series_id: number | null; media_json: string }[];
  const links = new Map<number, number>();
  for (const t of tracked) {
    const match = matchKavita(JSON.parse(t.media_json), t.kavita_series_id);
    if (match) links.set(match.seriesId, t.id);
  }
  const visible = mediaVisibility();
  return indexedSeries()
    .filter(
      (s) =>
        visible({
          ...emptyMedia(`kavita:${s.seriesId}`, s.name, 'MANGA'),
          adult: s.adult,
          trackedId: links.get(s.seriesId) ?? null,
        }) &&
        (!unmatched || !links.has(s.seriesId)) &&
        (!query || s.names.some((n) => normalizeTitle(n).includes(normalizeTitle(query)))),
    )
    .map((s) => ({
      seriesId: s.seriesId,
      libraryId: s.libraryId,
      libraryName: s.libraryName,
      name: s.name,
      chapters: s.numbers.length,
      coverUrl: `/api/kavita/image?seriesId=${s.seriesId}`,
      url: seriesUrl(s),
      trackedId: links.get(s.seriesId) ?? null,
    }));
}
export async function kavitaLibraries(signal?: AbortSignal): Promise<KavitaLibrary[]> {
  const libraries = z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().nullable(),
        type: z.union([z.number(), z.string()]),
        folders: z.array(z.string()).nullable().optional(),
      }),
    )
    .parse(await kavitaJson('/api/Library/libraries', { signal }));
  const suggested = suggestLibraries(
    libraries.map((l) => ({
      ...l,
      name: l.name ?? '',
      type:
        typeof l.type === 'number'
          ? (['Manga', 'Comic', 'Book', 'Image', 'LightNovel', 'ComicVine'][l.type] ??
            String(l.type))
          : l.type,
      folders: (l.folders ?? []).map((f) => ({ path: f, localPath: null, writable: false })),
    })),
  );
  stateSet('kavita_libraries', JSON.stringify(suggested));
  return Promise.all(
    suggested.map(async (l) => ({
      ...l,
      suggestedFor: l.suggestedFor.filter((kind) => getSettings().libraryTargets[kind] !== null),
      folders: await Promise.all(
        l.folders.map(async (f) => {
          const localPath = resolveLibraryFolder(
            f.path,
            indexedSeries()
              .filter((s) => s.libraryId === l.id)
              .flatMap((s) => (s.folder ? [s.folder] : [])),
          );
          return { ...f, localPath, writable: localPath ? await writableFolder(localPath) : false };
        }),
      ),
    })),
  );
}
export function guessLibraryKind(name: string, type: string): import('@/types/shared').LibraryKind {
  return suggestedLibraryKind(name, type) ?? 'MANGA';
}
export function suggestLibraries(
  libraries: Omit<KavitaLibrary, 'suggestedFor'>[],
): KavitaLibrary[] {
  return libraries.map((l) => {
    const kind = suggestedLibraryKind(l.name, l.type);
    return { ...l, suggestedFor: kind ? [kind] : [] };
  });
}
/** Specials and volume-only (-100000/default chapter) entries are not chapter zero. */
export function kavitaChapterNumbers(input: unknown): number[] {
  const volumes = z
    .array(
      z.object({
        chapters: z
          .array(
            z.object({
              isSpecial: z.boolean().optional(),
              minNumber: z.number().optional(),
              maxNumber: z.number().optional(),
              number: z.union([z.string(), z.number()]).nullable().optional(),
              range: z.string().nullable().optional(),
            }),
          )
          .nullable(),
      }),
    )
    .parse(input);
  const numbers = new Set<number>();
  for (const c of volumes.flatMap((v) => v.chapters ?? [])) {
    if (c.isSpecial || (c.maxNumber !== undefined && c.maxNumber < 0)) continue;
    const label = c.range ?? (c.number == null ? '' : String(c.number));
    if (/^\d+(?:\.\d+)?$/.test(label)) numbers.add(Number(label));
    else if (/^\d+\s*-\s*\d+$/.test(label)) {
      const [min, max] = label.split('-').map(Number);
      if (max >= min && max - min <= 2000) for (let n = min; n <= max; n++) numbers.add(n);
    } else if (
      c.minNumber !== undefined &&
      c.maxNumber !== undefined &&
      c.minNumber >= 0 &&
      c.minNumber === c.maxNumber
    )
      numbers.add(c.maxNumber);
    else if (c.maxNumber !== undefined && c.maxNumber >= 0 && c.minNumber === undefined)
      numbers.add(c.maxNumber);
  }
  return [...numbers].sort((a, b) => a - b);
}
function stateValue(key: string) {
  return (
    (
      db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value ?? null
  );
}
function stateSet(key: string, value: string) {
  db()
    .prepare(
      'INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value);
}
export function kavitaIndexStatus(): KavitaIndexStatus {
  const s = getSettings();
  return {
    state:
      !s.kavitaUrl || !s.kavitaApiKey
        ? 'unconfigured'
        : stateValue('kavita_error') === '1'
          ? 'error'
          : 'ok',
    series: indexedSeries().length,
    syncedAt: stateValue('kavita_synced_at'),
  };
}
export function requestKavitaSync() {
  stateSet('kavita_sync_requested', '1');
  stateSet('kavita_retry_at', '0');
  wakeWorker();
}
export function kavitaSyncRequested() {
  return (
    stateValue('kavita_sync_requested') === '1' &&
    Date.now() >= Number(stateValue('kavita_retry_at') ?? 0)
  );
}
let syncing: Promise<void> | undefined;
export async function syncKavitaIndex() {
  if (syncing) return syncing;
  syncing = (async () => {
    const settings = getSettings();
    if (!settings.kavitaUrl || !settings.kavitaApiKey) return;
    try {
      const libraries = await kavitaLibraries();
      const result: IndexedSeries[] = [];
      for (const library of libraries) {
        for (let page = 1; ; page++) {
          if (page > 10000)
            throw new AppError(
              'KAVITA_INDEX_TOO_LARGE',
              'Kavita index exceeds pagination limit',
              502,
            );
          const rows = z.array(seriesSchema).parse(
            await kavitaJson(`/api/Series/all-v2?PageNumber=${page}&PageSize=200`, {
              method: 'POST',
              body: JSON.stringify({
                statements: [{ field: 19, comparison: 0, value: String(library.id) }],
                combination: 1,
              }),
            }),
          );
          await eachConcurrent(rows, 4, async (row) => {
            if (row.libraryId !== library.id)
              throw new AppError(
                'KAVITA_INDEX_INVALID',
                'Kavita returned a series in a different library',
                502,
              );
            const metadata = await kavitaJson<{
              ageRating?: number | string;
              summary?: string | null;
              genres?: { title: string }[] | null;
            }>(`/api/Series/metadata?seriesId=${row.id}`);
            const volumes = await kavitaJson(`/api/Series/volumes?seriesId=${row.id}`);
            result.push({
              seriesId: row.id,
              libraryId: library.id,
              libraryName: library.name,
              name: row.name ?? '',
              names: [
                ...new Set(
                  [row.name, row.localizedName, row.originalName, row.sortName].filter(
                    (n): n is string => !!n,
                  ),
                ),
              ],
              folder: row.folderPath || row.lowestFolderPath || null,
              numbers: kavitaChapterNumbers(volumes),
              adult:
                typeof metadata.ageRating === 'number'
                  ? metadata.ageRating >= 14
                  : /^(x18\+?|x18plus|explicit)$/i.test(metadata.ageRating ?? ''),
              summary: metadata.summary ?? null,
              genres: metadata.genres?.map((g) => g.title) ?? [],
              kind: guessLibraryKind(library.name, library.type),
              completed: allKavitaRead(volumes),
            });
          });
          if (rows.length < 200) break;
        }
      }
      db().transaction(() => {
        db().prepare('DELETE FROM kavita_series').run();
        const insert = db().prepare('INSERT INTO kavita_series(series_id,payload) VALUES(?,?)');
        for (const series of result) insert.run(series.seriesId, JSON.stringify(series));
        stateSet('kavita_synced_at', new Date().toISOString());
        stateSet('kavita_error', '0');
        stateSet('kavita_retry_at', '0');
        stateSet('kavita_sync_requested', '0');
      })();
      if (getSettings().autoImportKavita) {
        const { autoImportKavita } = await import('./kavita-track');
        await autoImportKavita();
      }
    } catch {
      stateSet('kavita_error', '1');
      stateSet('kavita_retry_at', String(Date.now() + 60_000));
    }
  })();
  try {
    await syncing;
  } finally {
    syncing = undefined;
  }
}

export function allKavitaRead(input: unknown): boolean {
  const volumes = z
    .array(
      z.object({
        chapters: z
          .array(z.object({ pages: z.number().optional(), pagesRead: z.number().optional() }))
          .nullable(),
      }),
    )
    .parse(input);
  const chapters = volumes.flatMap((v) => v.chapters ?? []);
  return (
    chapters.length > 0 &&
    chapters.every((c) => (c.pages ?? 0) > 0 && (c.pagesRead ?? 0) >= c.pages!)
  );
}
