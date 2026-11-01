import path from 'node:path';
import { chapterVolume } from './chapter-volume';
import { chapterNumber } from './suwayomi';
import { bookFormat } from './openlibrary';
import { createHash } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { tenantSignal } from './tenant-lifecycle';
import { tenantState } from './tenant-context';
import { mediaVisibility } from './adult';
import { wakeWorker } from './worker-events';
import { z } from 'zod';
import { db, statement, writeVersion } from './db';
import { getSettings } from './settings';
import { emptyMedia, normalizeTitle } from './media';
import { kavitaJson } from './kavita-client';
import { resolveLibraryFolder, writableFolder } from './library-paths';
import { mediaRootStatus, mediaRootOptions } from './media-root';
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
  lastModified: z.string().nullable().optional(),
  lastModifiedUtc: z.string().nullable().optional(),
  lastChapterAdded: z.string().nullable().optional(),
  lastChapterAddedUtc: z.string().nullable().optional(),
  lastFolderScanned: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  format: z.union([z.number(), z.string()]).optional(),
  pages: z.number().optional(),
  pagesRead: z.number().optional(),
  latestReadDate: z.string().nullable().optional(),
});
export interface IndexedSeries {
  revision?: string | null;
  adult?: boolean;
  seriesId: number;
  libraryId: number;
  libraryName: string;
  name: string;
  names: string[];
  folder: string | null;
  numbers: number[];
  chapterFiles?: { number: number; volume: number | null; path: string | null }[];
  /** Explicit complete-volume archives; partial chapter groupings are excluded. */
  volumes?: number[];
  volumeRead?: number | null;
  summary?: string | null;
  genres?: string[];
  kind?: import('@/types/shared').LibraryKind;
  completed?: boolean;
}
const seriesSnapshotCache = tenantState(() => ({
  value: undefined as
    | {
        version: number;
        entries: IndexedSeries[];
        ids: Map<number, IndexedSeries>;
        names: Map<string, IndexedSeries[]>;
      }
    | undefined,
}));
function seriesIndex() {
  const seriesSnapshot = seriesSnapshotCache().value;
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
  if (!db().inTransaction) seriesSnapshotCache().value = snapshot;
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
const linkageCache = tenantState(() => ({
  value: undefined as
    | {
        version: number;
        ids: Map<string, Link>;
        anilist: Map<number, Link>;
        mangadex: Map<string, Link>;
      }
    | undefined,
}));
type Link = { kavita_series_id: number | null; kavita_manual: number };
/** Capture an indexed resolver once per catalog/library operation. */
export function kavitaMatcher() {
  const linkage = linkageCache().value;
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
    if (!db().inTransaction) linkageCache().value = links;
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
    .all() as {
    id: number;
    kavita_series_id: number | null;
    media_json: string;
  }[];
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
export function kavitaIndexStatus(): KavitaIndexStatus & {
  mediaRootOptions: ReturnType<typeof mediaRootOptions>;
} {
  const s = getSettings();
  return {
    mediaRoot: mediaRootStatus(),
    mediaRootOptions: mediaRootOptions(),
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
    (stateValue('kavita_sync_requested') === '1' ||
      Date.now() - Date.parse(stateValue('kavita_synced_at') ?? '') >= 15 * 60_000 ||
      (!stateValue('kavita_synced_at') && !!getSettings().kavitaApiKey)) &&
    Date.now() >= Number(stateValue('kavita_retry_at') ?? 0)
  );
}
const syncState = tenantState(() => ({ syncing: undefined as Promise<void> | undefined }));
export async function syncKavitaIndex(parentSignal?: AbortSignal) {
  const state = syncState();
  if (state.syncing) return state.syncing;
  state.syncing = (async () => {
    const settings = getSettings();
    if (!settings.kavitaUrl || !settings.kavitaApiKey) return;
    try {
      const signal = AbortSignal.any([tenantSignal(), ...(parentSignal ? [parentSignal] : [])]);
      const context = createHash('sha256')
        .update(
          JSON.stringify([settings.kavitaUrl, settings.kavitaApiKey, settings.kavitaAuthMode]),
        )
        .digest('hex');
      const full =
        stateValue('kavita_index_context') !== context ||
        Date.now() - Number(stateValue('kavita_full_sync') ?? 0) >= 86400_000;
      const previous = new Map(indexedSeries().map((s) => [s.seriesId, s]));
      const libraries = await kavitaLibraries(signal);
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
              signal,
              body: JSON.stringify({
                statements: [{ field: 19, comparison: 0, value: String(library.id) }],
                combination: 1,
              }),
            }),
          );
          await eachConcurrent(rows, 2, async (row) => {
            signal.throwIfAborted();
            const changed = [
              row.lastModifiedUtc,
              row.lastModified,
              row.updatedAt,
              row.lastChapterAddedUtc,
              row.lastChapterAdded,
              row.lastFolderScanned,
            ];
            const revision = changed.some((v) => v && !v.startsWith('0001-'))
              ? JSON.stringify([row, library.name, library.type])
              : null;
            const old = previous.get(row.id);
            if (!full && revision && old?.revision === revision) {
              result.push(old);
              return;
            }
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
            }>(`/api/Series/metadata?seriesId=${row.id}`, { signal });
            const volumes = await kavitaJson(`/api/Series/volumes?seriesId=${row.id}`, { signal });
            result.push({
              revision,
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
              chapterFiles: kavitaChapterFiles(volumes),
              ...kavitaVolumeProgress(volumes),
              adult:
                typeof metadata.ageRating === 'number'
                  ? metadata.ageRating >= 14
                  : /^(x18\+?|x18plus|explicit)$/i.test(metadata.ageRating ?? ''),
              summary: metadata.summary ?? null,
              genres: metadata.genres?.map((g) => g.title) ?? [],
              kind: (() => {
                let kind = guessLibraryKind(library.name, library.type);
                // Kavita MangaFormat: EPUB=3, PDF=4. Book libraries are fiction by default.
                if (
                  kind === 'MANGA' &&
                  (row.format === 3 || row.format === 4 || /epub|pdf/i.test(String(row.format)))
                )
                  kind = 'NOVEL';
                if (
                  kind === 'NOVEL' &&
                  bookFormat(metadata.genres?.map((g) => g.title) ?? []) === 'BOOK'
                )
                  kind = 'BOOK';
                return kind;
              })(),
              completed: allKavitaRead(volumes),
            });
          });
          await yieldIO();
          if (rows.length < 200) break;
        }
      }
      db().transaction(() => {
        signal.throwIfAborted();
        if (
          getSettings().kavitaUrl !== settings.kavitaUrl ||
          getSettings().kavitaApiKey !== settings.kavitaApiKey
        )
          throw new Error('Connection changed');
        const found = new Set(result.map((s) => s.seriesId));
        for (const [id, old] of previous)
          if (!found.has(id))
            statement('DELETE FROM kavita_series WHERE series_id=? AND payload=?').run(
              id,
              JSON.stringify(old),
            );
        const insert = db().prepare(
          'INSERT INTO kavita_series(series_id,payload) VALUES(?,?) ON CONFLICT(series_id) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload',
        );
        for (const series of result) {
          const live = statement('SELECT payload FROM kavita_series WHERE series_id=?').get(
            series.seriesId,
          ) as { payload: string } | undefined;
          // A targeted post-scan refresh may have published while this snapshot was fetching.
          if (live && live.payload !== JSON.stringify(previous.get(series.seriesId))) continue;
          insert.run(series.seriesId, JSON.stringify(series));
        }
        if (full) stateSet('kavita_full_sync', String(Date.now()));
        stateSet('kavita_index_context', context);
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
    await state.syncing;
  } finally {
    state.syncing = undefined;
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

/** A volume folder with chapter files is partial evidence, not a complete volume archive. */
export function kavitaVolumeProgress(input: unknown): {
  volumes: number[];
  volumeRead: number | null;
} {
  const rows = z
    .array(
      z.object({
        minNumber: z.number().optional(),
        maxNumber: z.number().optional(),
        number: z.union([z.string(), z.number()]).nullable().optional(),
        name: z.string().optional(),
        chapters: z
          .array(
            z.object({
              pages: z.number().optional(),
              pagesRead: z.number().optional(),
              files: z
                .array(z.object({ filePath: z.string() }))
                .nullable()
                .optional(),
            }),
          )
          .nullable(),
      }),
    )
    .parse(input);
  const owned = new Set<number>();
  const read = new Set<number>();
  for (const v of rows) {
    const raw = v.number ?? v.name;
    const number =
      raw != null && /^\d+(?:\.\d+)?$/.test(String(raw))
        ? Number(raw)
        : v.minNumber === v.maxNumber
          ? v.minNumber
          : undefined;
    if (number == null || !Number.isFinite(number) || number <= 0 || !v.chapters?.length) continue;
    const complete = v.chapters.filter((c) =>
      c.files?.some((f) => {
        const basename = path.posix.basename(f.filePath.replaceAll('\\', '/'));
        return (
          /\.(?:cbz|cbr|epub|pdf)$/i.test(basename) &&
          chapterVolume(basename) === number &&
          chapterNumber(basename) === null
        );
      }),
    );
    if (!complete.length) continue;
    owned.add(number);
    if (complete.every((c) => (c.pages ?? 0) > 0 && (c.pagesRead ?? 0) >= c.pages!))
      read.add(number);
  }
  return {
    volumes: [...owned].sort((a, b) => a - b),
    volumeRead: owned.size ? Math.max(0, ...read) : null,
  };
}

/** Kavita chapter file paths let imported and pre-existing archives use the same safe reader. */
export function kavitaChapterFiles(input: unknown): NonNullable<IndexedSeries['chapterFiles']> {
  const rows = z
    .array(
      z
        .object({
          number: z.union([z.string(), z.number()]).nullable().optional(),
          minNumber: z.number().optional(),
          maxNumber: z.number().optional(),
          chapters: z
            .array(
              z
                .object({
                  files: z
                    .array(z.object({ filePath: z.string() }))
                    .nullable()
                    .optional(),
                })
                .passthrough(),
            )
            .nullable(),
        })
        .passthrough(),
    )
    .parse(input);
  return rows.flatMap((v) => {
    const n =
      v.number == null ? (v.minNumber === v.maxNumber ? v.minNumber : NaN) : Number(v.number);
    const volume = n != null && Number.isFinite(n) && n > 0 ? n : null;
    return (v.chapters ?? []).flatMap((c) =>
      kavitaChapterNumbers([{ chapters: [c] }]).map((number) => ({
        number,
        volume,
        path: c.files?.length === 1 ? c.files[0].filePath : null,
      })),
    );
  });
}

/** A scan is asynchronous in Kavita: poll just its series, bounded to ten seconds. */
export async function refreshScannedSeries(
  media: UnifiedMedia,
  folder: string,
  parentSignal?: AbortSignal,
) {
  const settings = getSettings();
  const signal = AbortSignal.any([
    tenantSignal(),
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(10_000),
  ]);
  const { trackedForMedia, listTracked } = await import('./db');
  const tracked = trackedForMedia(media, listTracked());
  const imports = statement(
    "SELECT number,volume FROM imported_chapters WHERE tracked_id=? OR media_json ->> '$.id'=?",
  ).all(tracked?.id ?? null, media.id) as { number: number | null; volume: number | null }[];
  const expected = new Set(imports.flatMap((c) => c.number ?? []));
  const expectedVolumes = new Set(imports.flatMap((c) => c.volume ?? []));
  const sameConnection = () => {
    const s = getSettings();
    return (
      s.kavitaUrl === settings.kavitaUrl &&
      s.kavitaApiKey === settings.kavitaApiKey &&
      s.kavitaAuthMode === settings.kavitaAuthMode &&
      s.mediaRoot === settings.mediaRoot
    );
  };
  let id = matchKavita(media)?.seriesId;
  try {
    const { setTimeout: pause } = await import('node:timers/promises');
    for (const delay of [0, 250, 500, 1000, 2000, 3000]) {
      if (delay) await pause(delay, undefined, { signal });
      signal.throwIfAborted();
      if (!id) {
        const hits = z
          .object({
            series: z.array(z.object({ seriesId: z.number().int().positive() })).nullable(),
          })
          .parse(
            await kavitaJson(
              `/api/Search/search?queryString=${encodeURIComponent(media.title)}&includeChapterAndFiles=false`,
              { signal },
            ),
          );
        const candidates = [];
        for (const hit of (hits.series ?? []).slice(0, 20)) {
          const row = seriesSchema.parse(
            await kavitaJson(`/api/Series/${hit.seriesId}`, { signal }),
          );
          if (
            [row.folderPath, row.lowestFolderPath].some(
              (p) => p?.replace(/\\/g, '/').replace(/\/+$/, '') === folder.replace(/\/+$/, ''),
            )
          )
            candidates.push(row);
        }
        if (candidates.length === 1) id = candidates[0].id;
      }
      if (!id) continue;
      const row = seriesSchema.parse(await kavitaJson(`/api/Series/${id}`, { signal }));
      // Never attach a similarly named series from a different folder/library.
      if (
        ![row.folderPath, row.lowestFolderPath].some(
          (p) => p?.replace(/\/+$/, '') === folder.replace(/\/+$/, ''),
        )
      ) {
        id = undefined;
        continue;
      }
      const volumes = await kavitaJson(`/api/Series/volumes?seriesId=${id}`, { signal });
      const old = indexedSeriesById(id);
      const library = (await kavitaLibraries(signal)).find((l) => l.id === row.libraryId);
      if (!library) continue;
      const metadata = old
        ? null
        : await kavitaJson<{
            ageRating?: number | string;
            summary?: string | null;
            genres?: { title: string }[] | null;
          }>(`/api/Series/metadata?seriesId=${id}`, { signal });
      const series: IndexedSeries = {
        ...old,
        ...(metadata
          ? {
              summary: metadata.summary ?? null,
              genres: metadata.genres?.map((g) => g.title) ?? [],
              adult:
                typeof metadata.ageRating === 'number'
                  ? metadata.ageRating >= 14
                  : /^(x18\+?|x18plus|explicit)$/i.test(metadata.ageRating ?? ''),
            }
          : {}),
        revision: null,
        seriesId: id,
        libraryId: row.libraryId,
        libraryName: library.name,
        name: row.name ?? '',
        names: [
          ...new Set(
            [row.name, row.localizedName, row.originalName, row.sortName].filter(
              (n): n is string => !!n,
            ),
          ),
        ],
        folder: row.folderPath || row.lowestFolderPath || folder,
        numbers: kavitaChapterNumbers(volumes),
        chapterFiles: kavitaChapterFiles(volumes),
        ...kavitaVolumeProgress(volumes),
        completed: allKavitaRead(volumes),
        kind: old?.kind ?? guessLibraryKind(library.name, library.type),
      };
      signal.throwIfAborted();
      if (!sameConnection()) return;
      db().transaction(() => {
        statement(
          'INSERT INTO kavita_series(series_id,payload) VALUES(?,?) ON CONFLICT(series_id) DO UPDATE SET payload=excluded.payload',
        ).run(id, JSON.stringify(series));
        if (tracked)
          statement(
            `UPDATE tracked_media SET kavita_series_id=? WHERE id=? AND media_json ->> '$.id'=? AND kavita_manual=0 AND (kavita_series_id IS NULL OR kavita_series_id=?)`,
          ).run(id, tracked.id, tracked.media.id, id);
      })();
      if (
        [...expected].every((n) => series.numbers.includes(n)) &&
        [...expectedVolumes].every((n) => kavitaChapterFiles(volumes).some((c) => c.volume === n))
      )
        return;
    }
  } catch {
    parentSignal?.throwIfAborted();
    tenantSignal().throwIfAborted();
  }
  // The scan succeeded but indexing is late/unavailable; retain imports and retry durably.
  if (sameConnection()) requestKavitaSync();
}

/**
 * Ask Kavita to rescan one followed series' folder, then re-read its volumes until something
 * changes (Kavita scans asynchronously) or ~12 seconds pass. Other indexed fields are kept.
 */
export async function refreshSeriesNow(seriesId: number, parentSignal?: AbortSignal) {
  const signal = AbortSignal.any([
    tenantSignal(),
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(15_000),
  ]);
  const old = indexedSeriesById(seriesId);
  if (!old) throw new AppError('NOT_FOUND', 'Series is not indexed', 404);
  let scanned = false;
  if (old.folder)
    try {
      const { scanKavitaFolder } = await import('./kavita-client');
      await scanKavitaFolder(old.folder, signal);
      scanned = true;
    } catch {
      /* Without a scan, re-reading still picks up what Kavita already knows. */
    }
  const before = JSON.stringify([old.numbers, old.volumes, old.chapterFiles]);
  const { setTimeout: pause } = await import('node:timers/promises');
  let changed = false;
  for (const delay of scanned ? [500, 1000, 1500, 2500, 3000, 3500] : [0]) {
    await pause(delay, undefined, { signal });
    const volumes = await kavitaJson(`/api/Series/volumes?seriesId=${seriesId}`, { signal });
    const series: IndexedSeries = {
      ...old,
      numbers: kavitaChapterNumbers(volumes),
      chapterFiles: kavitaChapterFiles(volumes),
      ...kavitaVolumeProgress(volumes),
      completed: allKavitaRead(volumes),
    };
    signal.throwIfAborted();
    statement('UPDATE kavita_series SET payload=? WHERE series_id=?').run(
      JSON.stringify(series),
      seriesId,
    );
    if (JSON.stringify([series.numbers, series.volumes, series.chapterFiles]) !== before) {
      changed = true;
      break;
    }
  }
  return { scanned, changed };
}
