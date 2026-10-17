import { mediaId as mediaIdentifier } from './validation';
import { mediaDetail } from './catalog';
import { sourceFormat } from './library-kinds';
import { z } from 'zod';
import { db, statement, listTracked } from './db';
import {
  chapterState,
  chaptersFor,
  chapterNumber,
  fetchChapterPages,
  suwayomiHeaders,
} from './suwayomi';
import { chapterVolume } from './chapter-volume';
import { getSettings } from './settings';
import { cachedImageResponse, suwayomiImageKey } from './image-cache';
import { cached } from './metadata-cache';
import { pageImage } from './chapter-pages';
import { endpoint } from './http';
import { AppError } from './errors';
import {
  readerArchive,
  readerNeighbours,
  readerNamespace,
  type ReaderSourceChapter,
} from './reader-archives';
import { cbzPage, cbzPages } from './cbz-reader';
import type { ReaderChapter, ReaderProgressUpdate, UnifiedMedia } from '@/types/shared';
import { tenantState } from './tenant-context';
import { tenantSignal } from './tenant-lifecycle';
interface ChapterData {
  chapter: ReaderSourceChapter;
  urls: string[];
  neighbours: { id: number; number: number | null }[];
}
export function readerDirection(
  media?: Pick<UnifiedMedia, 'format' | 'genres'>,
): ReaderChapter['direction'] {
  if (media?.format === 'COMIC') return 'ltr';
  if (
    media?.format === 'MANHWA' ||
    media?.format === 'MANHUA' ||
    media?.genres.some((g) => /webtoon/i.test(g))
  )
    return 'vertical';
  return 'rtl';
}
async function chapterData(id: number, signal?: AbortSignal): Promise<ChapterData> {
  const namespace = readerNamespace();
  return cached(`reader:chapter:${namespace}:${id}`, 5 * 60_000, async () => {
    const chapter = await chapterState(id, signal);
    const manga = chapter.manga;
    if (!manga?.id || !manga.source)
      throw new AppError('INVALID_CHAPTER', 'Chapter source is unavailable', 502);
    const [urls, siblings] = await Promise.all([
      fetchChapterPages(id, signal),
      chaptersFor(
        [{ suwayomiMangaId: manga.id, sourceId: manga.source.id, sourceName: manga.source.name }],
        signal,
      ),
    ]);
    return {
      chapter,
      urls,
      neighbours: siblings.chapters.flatMap((c) =>
        c.variants.map((v) => ({ id: v.id, number: v.number })),
      ),
    };
  });
}
function work(id: string | undefined, mangaId: number) {
  const entries = listTracked();
  return id
    ? entries.find(
        (t) =>
          t.media.id === id ||
          (t.anilistId !== null && id === `anilist:${t.anilistId}`) ||
          (t.mangadexId !== null && id === `mangadex:${t.mangadexId}`) ||
          (t.media.mangaUpdatesId !== null && id === `mangaupdates:${t.media.mangaUpdatesId}`),
      )
    : entries.find((t) => t.sources.some((s) => s.suwayomiMangaId === mangaId));
}
export async function readerChapter(
  id: number,
  mediaId?: string,
  signal?: AbortSignal,
): Promise<ReaderChapter> {
  const local = await readerArchive(id);
  const data = local
    ? {
        chapter: local.chapter,
        urls: (await cbzPages(local.filename)).map(() => ''),
        neighbours: readerNeighbours(
          local.chapter.manga?.id ?? 0,
          chapterNumber(local.chapter.name, local.chapter.chapterNumber),
        ),
      }
    : await chapterData(id, signal);
  const chapter = data.chapter;
  const mangaId = chapter.manga?.id ?? 0;
  const number = chapterNumber(chapter.name, chapter.chapterNumber);
  const neighbours = data.neighbours
    .filter((c) => c.id !== id && c.number !== null)
    .sort((a, b) => a.number! - b.number! || a.id - b.id);
  const tracked = work(mediaId, mangaId);
  const imported = local
    ? (statement('SELECT media_json FROM imported_chapters WHERE chapter_id=?').get(id) as
        { media_json: string } | undefined)
    : undefined;
  const importedMedia = imported ? (JSON.parse(imported.media_json) as UnifiedMedia) : undefined;
  const formatMedia =
    tracked?.media ??
    importedMedia ??
    (mediaId && !local
      ? await mediaDetail(mediaId, signal)
      : { format: sourceFormat(chapter.manga?.source?.name ?? ''), genres: [] });
  const position = statement(
    'SELECT page FROM reader_progress WHERE media_id=? AND chapter_id=?',
  ).get(tracked?.media.id ?? mediaId ?? '', id) as { page: number } | undefined;
  return {
    chapterId: id,
    mangaId,
    sourceName: chapter.manga?.source?.name ?? '',
    label: chapter.name,
    number,
    volume: chapterVolume(chapter.name, chapter.volume),
    pages: data.urls.map((_, index) => `/api/reader/page?chapter=${id}&index=${index}`),
    prevId:
      number === null ? null : (neighbours.filter((c) => c.number! < number).at(-1)?.id ?? null),
    nextId: number === null ? null : (neighbours.find((c) => c.number! > number)?.id ?? null),
    direction: readerDirection(formatMedia),
    resumePage: position ? Math.min(position.page, data.urls.length - 1) : null,
  };
}
export async function readerPage(request: Request, id: number, index: number) {
  const local = await readerArchive(id);
  if (local) {
    const pages = await cbzPages(local.filename);
    if (!pages[index]) throw new AppError('NOT_FOUND', 'Page not found', 404);
    // Include file identity so a replaced import cannot revive an older cached page.
    const { stat } = await import('node:fs/promises');
    const info = await stat(local.filename);
    return cachedImageResponse(
      request,
      `reader:local:${readerNamespace()}:${id}:${index}:${info.size}:${info.mtimeMs}`,
      () => cbzPage(local.filename, pages[index]),
    );
  }
  const data = await chapterData(id, request.signal);
  const url = data.urls[index];
  if (!url) throw new AppError('NOT_FOUND', 'Page not found', 404);
  return cachedImageResponse(request, suwayomiImageKey(`page:${url}`), async () => {
    const page = await pageImage(
      endpoint(getSettings().suwayomiUrl, url),
      suwayomiHeaders(),
      AbortSignal.any([request.signal, tenantSignal()]),
    );
    return {
      bytes: page.bytes,
      mime: `image/${page.extension === 'jpg' ? 'jpeg' : page.extension}`,
    };
  });
}
export const readerProgressBody = z
  .object({
    mediaId: mediaIdentifier,
    chapterId: z.number().int().positive(),
    number: z.number().finite().nonnegative().nullable(),
    page: z.number().int().min(0).max(1999),
    pageCount: z.number().int().min(1).max(2000),
  })
  .strict()
  .refine((v) => v.page < v.pageCount, 'Page exceeds chapter');
const writes = tenantState(
  () =>
    new Map<
      string,
      { at: number; pending?: ReaderProgressUpdate; last?: string; timer?: NodeJS.Timeout }
    >(),
);
function persistProgress(value: ReaderProgressUpdate) {
  if (tenantSignal().aborted) return;
  db().transaction(() => {
    const previous = statement(
      'SELECT MAX(updated_at) AS at FROM reader_progress WHERE media_id=?',
    ).get(value.mediaId) as { at: string | null };
    const now = new Date(
      Math.max(Date.now(), previous.at ? Date.parse(previous.at) + 1 : 0),
    ).toISOString();
    statement(`INSERT INTO reader_progress(media_id,chapter_id,number,page,page_count,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(media_id,chapter_id) DO UPDATE SET page=excluded.page,page_count=excluded.page_count,number=excluded.number,updated_at=excluded.updated_at`).run(
      value.mediaId,
      value.chapterId,
      value.number,
      value.page,
      value.pageCount,
      now,
    );
    statement(
      `UPDATE tracked_media SET last_read_at=?,last_read=CASE WHEN ? AND ? IS NOT NULL THEN MAX(COALESCE(last_read,0),?) ELSE last_read END WHERE media_json ->> '$.id'=?`,
    ).run(
      now,
      value.page === value.pageCount - 1 ? 1 : 0,
      value.number,
      value.number,
      value.mediaId,
    );
  })();
}
export async function saveReaderProgress(value: ReaderProgressUpdate, signal?: AbortSignal) {
  const entry = work(value.mediaId, 0);
  const chapter = await readerChapter(value.chapterId, entry ? value.mediaId : undefined, signal);
  const tracked = entry;
  if (
    !entry &&
    value.mediaId.startsWith('suwayomi:') &&
    value.mediaId !== `suwayomi:${chapter.mangaId}`
  )
    throw new AppError('NOT_FOUND', 'Reading work does not match this chapter', 404);
  value = { ...value, mediaId: entry?.media.id ?? value.mediaId };
  if (
    tracked &&
    !(
      tracked.sources.some((s) => s.suwayomiMangaId === chapter.mangaId) ||
      tracked.media.sources.some((s) => s.suwayomiMangaId === chapter.mangaId) ||
      tracked.media.id === `suwayomi:${chapter.mangaId}`
    )
  )
    throw new AppError('NOT_FOUND', 'Reading entry is not linked to this chapter', 404);
  if (chapter.pages.length !== value.pageCount || chapter.number !== value.number)
    throw new AppError('VALIDATION_ERROR', 'Chapter progress does not match its pages', 400);
  const states = writes();
  let state = states.get(value.mediaId);
  const persisted = entry
    ? Boolean(entry.readerPosition)
    : Boolean(
        statement('SELECT 1 FROM reader_progress WHERE media_id=? LIMIT 1').get(value.mediaId),
      );
  if (!persisted && state) {
    clearTimeout(state.timer);
    states.delete(value.mediaId);
    state = undefined;
  }
  if (!state) states.set(value.mediaId, (state = { at: 0 }));
  const signature = JSON.stringify(value);
  if (state.last === signature && Date.now() - state.at < 1000) return;
  state.last = signature;
  state.pending = value;
  if (value.page === value.pageCount - 1 || Date.now() - state.at >= 1000) {
    clearTimeout(state.timer);
    persistProgress(value);
    state.at = Date.now();
    state.pending = undefined;
    state.timer = undefined;
  } else if (!state.timer) {
    state.timer = setTimeout(
      () => {
        if (state.pending) {
          try {
            persistProgress(state.pending);
          } catch {
            /* Account deletion cancels pending writes. */
          }
        }
        states.delete(value.mediaId);
      },
      1000 - (Date.now() - state.at),
    );
    state.timer.unref();
  }
}
