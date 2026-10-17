import path from 'node:path';
import { realpath, stat, readdir } from 'node:fs/promises';
import { chapterLabels } from './chapter-labels';
import { matchKavita } from './kavita-index';
import type { UnifiedMedia } from '@/types/shared';
import { statement } from './db';
import { sourceServerKey } from './source-server';
import { chapterNumber } from './suwayomi';
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
export function registerReaderArchive(filename: string, chapter: ReaderSourceChapter) {
  statement(`INSERT INTO reader_archives(chapter_id,namespace,filename,payload) VALUES(?,?,?,?)
    ON CONFLICT(chapter_id) DO UPDATE SET namespace=excluded.namespace,filename=excluded.filename,payload=excluded.payload`).run(
    chapter.id,
    readerNamespace(),
    filename,
    JSON.stringify(chapter),
  );
}
export async function readerArchive(id: number) {
  const row = statement(
    'SELECT filename,payload FROM reader_archives WHERE chapter_id=? AND namespace=?',
  ).get(id, readerNamespace()) as { filename: string; payload: string } | undefined;
  if (!row) return legacyArchive(id);
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
): Promise<{ filename: string; chapter: ReaderSourceChapter } | null> {
  const imported = statement(
    'SELECT media_json,number,source_id,source_name FROM imported_chapters WHERE chapter_id=?',
  ).get(id) as
    | {
        media_json: string;
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
    const folder = existing?.folder
      ? mapKavitaPath(existing.folder)
      : path.join(targetFor(media).local, seriesName(media));
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
    registerReaderArchive(actual, chapter);
    return { filename: actual, chapter };
  } catch {
    return null;
  }
}
