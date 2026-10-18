import { storageWorkKeys } from './library-storage';
import path from 'node:path';
import { realpath, stat, readdir } from 'node:fs/promises';
import { chapterLabels } from './chapter-labels';
import { matchKavita } from './kavita-index';
import type { UnifiedMedia } from '@/types/shared';
import { statement } from './db';
import { sourceServerKey } from './source-server';
import { chapterNumber } from './suwayomi';
import { importStockKey } from './owned-stock';
import { chapterVolume } from './chapter-volume';
import {
  inside,
  libraryRoot,
  safeLibraryDirectory,
  targetFor,
  mapKavitaPath,
} from './library-paths';
export type ReaderSourceChapter = {
  id: number;
  name: string;
  chapterNumber: number;
  volume?: number | null;
  manga?: { id: number; source?: { id: string; name: string } };
};
export const readerNamespace = () => `${sourceServerKey()}:reader`;
export function registerReaderArchive(
  filename: string,
  chapter: ReaderSourceChapter,
  namespace = readerNamespace(),
) {
  statement(`INSERT INTO reader_archives(chapter_id,namespace,filename,payload) VALUES(?,?,?,?)
    ON CONFLICT(namespace,chapter_id) DO UPDATE SET filename=excluded.filename,payload=excluded.payload`).run(
    chapter.id,
    namespace,
    filename,
    JSON.stringify(chapter),
  );
}
export async function readerArchive(id: number, namespace = readerNamespace()) {
  const row = statement(
    'SELECT filename,payload FROM reader_archives WHERE chapter_id=? AND namespace=?',
  ).get(id, namespace) as { filename: string; payload: string } | undefined;
  if (!row) return legacyArchive(id, namespace);
  try {
    if (!inside(libraryRoot(), row.filename)) return null;
    await safeLibraryDirectory(path.dirname(row.filename));
    const actual = await realpath(row.filename);
    if (!inside(await realpath(libraryRoot()), actual) || !(await stat(actual)).isFile())
      return null;
    return { filename: actual, chapter: JSON.parse(row.payload) as ReaderSourceChapter };
  } catch {
    return null;
  }
}
export function readerNeighbours(mangaId: number, number: number | null) {
  const rows = statement(
    "SELECT payload FROM reader_archives WHERE namespace=? AND json_extract(payload,'$.manga.id')=?",
  ).all(readerNamespace(), mangaId) as { payload: string }[];
  const inventory = statement(
    "SELECT payload FROM reader_chapters WHERE namespace=? AND json_extract(payload,'$.mangaId')=?",
  ).all(readerNamespace(), mangaId) as { payload: string }[];
  const known = inventory
    .map((r) => JSON.parse(r.payload) as { id: number; mangaId: number; number: number | null })
    .filter((c) => c.mangaId === mangaId);
  return [
    ...known,
    ...rows
      .map((r) => JSON.parse(r.payload) as ReaderSourceChapter)
      .filter((c) => c.manga?.id === mangaId)
      .map((c) => ({
        id: c.id,
        number: chapterNumber(c.name, c.chapterNumber),
        volume: chapterVolume(c.name, c.volume),
      })),
  ].filter((c) => c.number !== null && c.number !== number);
}

/** Locate imports made before the archive pointer existed, without contacting Suwayomi. */
async function legacyArchive(
  id: number,
  namespace: string,
): Promise<{ filename: string; chapter: ReaderSourceChapter } | null> {
  const imported = statement(
    'SELECT media_json,number,source_id,source_name,tracked_id FROM imported_chapters WHERE chapter_id=? AND namespace=?',
  ).get(id, namespace.replace(/:reader$/, '')) as
    | {
        media_json: string;
        tracked_id: number | null;
        number: number | null;
        source_id: string | null;
        source_name: string | null;
      }
    | undefined;
  if (!imported) return null;
  try {
    const media = JSON.parse(imported.media_json) as UnifiedMedia;
    const label = chapterLabels([id]).get(id);
    const source = media.sources.find((s) => s.sourceId === imported.source_id) ?? media.sources[0];
    const chapter: ReaderSourceChapter = {
      id,
      name: label?.name ?? `Chapter ${imported.number ?? ''}`,
      chapterNumber: imported.number ?? -1,
      ...(source
        ? {
            manga: {
              id: source.suwayomiMangaId,
              source: { id: source.sourceId, name: source.sourceName },
            },
          }
        : {}),
    };
    const { chapterFilename, seriesName } = await import('./kavita');
    const existing = matchKavita(media);
    const { workKey, mediaKey } = storageWorkKeys(media);
    const reserved = statement('SELECT folder FROM library_folders WHERE work_key IN (?,?)').all(
      workKey,
      mediaKey,
    ) as { folder: string }[];
    const target = targetFor(media);
    const known = reserved.find((r) => inside(target.local, r.folder))?.folder;
    const folder =
      known ??
      (existing?.folder
        ? mapKavitaPath(existing.folder)
        : path.join(target.local, seriesName(media)));
    if (!folder) return null;
    const safe = await safeLibraryDirectory(folder);
    let filename = path.join(safe, chapterFilename(media, chapter));
    try {
      await stat(filename);
    } catch {
      if (imported.number === null) return null;
      const [whole, decimal] = String(imported.number).split('.');
      const suffix = ` Ch. ${whole.padStart(4, '0')}${decimal ? `.${decimal}` : ''}.cbz`;
      const candidates = (await readdir(safe)).filter(
        (name) => name.startsWith(seriesName(media)) && name.endsWith(suffix),
      );
      if (candidates.length !== 1) return null;
      filename = path.join(safe, candidates[0]);
    }
    const actual = await realpath(filename);
    if (!inside(await realpath(libraryRoot()), actual)) return null;
    registerReaderArchive(actual, chapter, namespace);
    return { filename: actual, chapter };
  } catch {
    return null;
  }
}

/** Resolve an owned number without needing a live source or a Suwayomi chapter ID. */
export async function localNumberArchive(
  media: UnifiedMedia,
  number: number,
  unit: 'chapter' | 'volume' = 'chapter',
) {
  const { listTracked, trackedForMedia } = await import('./db');
  const { ownedStock } = await import('./owned-chapters');
  const stock = ownedStock(media);
  const owned =
    unit === 'volume'
      ? stock.volumes.includes(number)
        ? { number, volume: number }
        : null
      : stock.chapters.find((c) => c.number === number);
  if (!owned) return null;
  const tracked = trackedForMedia(media, listTracked());
  const imports = statement(`SELECT chapter_id,namespace FROM imported_chapters
    WHERE (tracked_id=? OR media_json ->> '$.id'=?) AND number=?`).all(
    tracked?.id ?? null,
    media.id,
    number,
  ) as { chapter_id: number; namespace: string }[];
  for (const row of imports) {
    if (stock.retypedImports.has(importStockKey(row)) !== (unit === 'volume')) continue;
    const archive = await readerArchive(row.chapter_id, `${row.namespace}:reader`);
    if (archive) return { filename: archive.filename, volume: owned.volume };
  }
  // A missing future chapter must never fall back to the same-numbered declared tome.
  if (unit === 'chapter' && stock.retyped.has(number)) return null;
  const series = matchKavita(media, tracked?.kavitaSeriesId);
  if (!series?.folder) return null;
  const mapped = mapKavitaPath(series.folder);
  if (!mapped) return null;
  try {
    const folder = await safeLibraryDirectory(mapped);
    const files =
      series.chapterFiles
        ?.filter(
          (c) => c.number === number && c.path && (unit === 'chapter' || stock.retyped.has(number)),
        )
        .map((c) => mapKavitaPath(c.path!))
        .filter((p): p is string => !!p) ?? [];
    const candidates = files.length
      ? [...new Set(files)]
      : (await readdir(folder))
          .filter(
            (name) =>
              /\.cbz$/i.test(name) &&
              (unit === 'chapter' || stock.retyped.has(number)
                ? chapterNumber(path.basename(name, path.extname(name))) === number
                : chapterNumber(path.basename(name, path.extname(name))) === null &&
                  chapterVolume(name) === number),
          )
          .map((name) => path.join(folder, name));
    if (candidates.length !== 1) return null;
    const actual = await realpath(candidates[0]);
    if (
      !inside(folder, actual) ||
      !inside(await realpath(libraryRoot()), actual) ||
      !(await stat(actual)).isFile()
    )
      return null;
    await safeLibraryDirectory(path.dirname(actual));
    return { filename: actual, volume: owned.volume };
  } catch {
    return null;
  }
}
