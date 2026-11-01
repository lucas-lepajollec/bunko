import { sourceServerKey } from './source-server';
import { importStockKey } from './owned-stock';
import { ownedStock } from './owned-chapters';
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
  localNumberArchive,
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
    const [urls] = await Promise.all([
      fetchChapterPages(id, signal),
      chaptersFor(
        [{ suwayomiMangaId: manga.id, sourceId: manga.source.id, sourceName: manga.source.name }],
        signal,
      ),
    ]);
    return { chapter, urls };
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
          (t.media.mangaUpdatesId !== null && id === `mangaupdates:${t.media.mangaUpdatesId}`) ||
          id === `kavita:${t.kavitaSeriesId ?? t.media.kavitaSeriesId}`,
      )
    : entries.find((t) => t.sources.some((s) => s.suwayomiMangaId === mangaId));
}
/** Resolve local identities from existing tenant records; local reading never needs metadata HTTP. */
async function localReadingWork(id: string) {
  const tracked =
    work(id, 0) ?? listTracked().find((t) => id === `kavita:${t.media.kavitaSeriesId}`);
  if (tracked) return tracked;
  if (/^kavita:[1-9]\d*$/.test(id)) {
    const { kavitaMedia } = await import('./kavita-track');
    return { id: 0, media: kavitaMedia(Number(id.slice(7))) };
  }
  const imported = statement(
    "SELECT media_json FROM imported_chapters WHERE media_json ->> '$.id'=? LIMIT 1",
  ).get(id) as { media_json: string } | undefined;
  return imported ? { id: 0, media: JSON.parse(imported.media_json) as UnifiedMedia } : undefined;
}
const localIdentity = (key: string) => ({
  mediaId: key.replace(/^@volume:/, ''),
  unit: key.startsWith('@volume:') ? ('volume' as const) : ('chapter' as const),
});

/** One numeric order for the sheet's owned stock and the reader. Source variants stay in
 * the selected reading lane; owned files from any historical connection fill its gaps.
 * Chapter and volume numbers are never compared to each other. No upstream call is needed. */
async function navigation(
  number: number | null,
  media: UnifiedMedia | undefined,
  mangaId: number,
  unit: 'chapter' | 'volume' = 'chapter',
) {
  const result = { prevId: null, nextId: null, prevLocal: null, nextLocal: null } as Pick<
    ReaderChapter,
    'prevId' | 'nextId' | 'prevLocal' | 'nextLocal'
  >;
  if (number === null) return result;
  const candidates = new Map<number, { id: number | null; owned: boolean }>();
  if (unit === 'chapter' && mangaId)
    for (const c of readerNeighbours(mangaId, number).sort((a, b) => b.id - a.id))
      if (c.number !== null) candidates.set(c.number, { id: c.id, owned: false });
  if (media) {
    const stock = ownedStock(media);
    const namespace = sourceServerKey();
    const numbers = unit === 'volume' ? stock.volumes : stock.chapters.map((c) => c.number);
    for (const n of numbers) candidates.set(n, { id: candidates.get(n)?.id ?? null, owned: true });
    // Explicitly retyped imports must not reappear as remote chapter neighbours.
    if (unit === 'chapter')
      for (const [n, candidate] of candidates)
        if (
          candidate.id &&
          stock.retypedImports.has(
            importStockKey({
              namespace,
              chapter_id: candidate.id,
            }),
          )
        )
          candidates.delete(n);
  }
  const ordered = [...candidates.keys()].sort((a, b) => a - b);
  for (const direction of ['prev', 'next'] as const) {
    const numbers =
      direction === 'prev'
        ? ordered.filter((n) => n < number).reverse()
        : ordered.filter((n) => n > number);
    for (const n of numbers) {
      const candidate = candidates.get(n)!;
      // Existing source URLs retain progress identity and use their archive when present.
      if (candidate.id) {
        result[`${direction}Id`] = candidate.id;
        break;
      }
      if (candidate.owned && media && (await localNumberArchive(media, n, unit))) {
        result[`${direction}Local`] = n;
        break;
      }
    }
  }
  return result;
}

export async function readerChapter(
  id: number,
  mediaId?: string,
  signal?: AbortSignal,
): Promise<ReaderChapter> {
  if (id < 0) {
    const row = statement('SELECT media_id,number FROM local_reader_chapters WHERE id=?').get(
      -id,
    ) as { media_id: string; number: number } | undefined;
    const local = row && localIdentity(row.media_id);
    if (
      !row ||
      !local ||
      (mediaId && (await localReadingWork(mediaId))?.media.id !== local.mediaId)
    )
      throw new AppError('NOT_FOUND', 'Local chapter not found', 404);
    return localReaderChapter(row.number, local.mediaId, local.unit);
  }
  const local = await readerArchive(id);
  if (!local) {
    // A pre-Bunko Kavita file has no source archive pointer. The sheet's persisted
    // variant lets old positive URLs resolve it even while Suwayomi is unavailable.
    const stored = statement(
      'SELECT payload FROM reader_chapters WHERE namespace=? AND chapter_id=?',
    ).get(readerNamespace(), id) as { payload: string } | undefined;
    const variant = stored
      ? (JSON.parse(stored.payload) as { mangaId: number; number: number | null })
      : null;
    const entry = variant && work(mediaId, variant.mangaId);
    if (
      entry &&
      variant?.number != null &&
      [...entry.sources, ...entry.media.sources].some((s) => s.suwayomiMangaId === variant.mangaId)
    ) {
      const stock = ownedStock(entry.media);
      const unit = stock.retypedImports.has(
        importStockKey({ namespace: sourceServerKey(), chapter_id: id }),
      )
        ? 'volume'
        : 'chapter';
      if (await localNumberArchive(entry.media, variant.number, unit))
        return localReaderChapter(variant.number, entry.media.id, unit, id);
    }
  }
  if (local) {
    const tracked = work(mediaId, local.chapter.manga?.id ?? 0);
    const number = chapterNumber(local.chapter.name, local.chapter.chapterNumber);
    if (
      tracked &&
      number !== null &&
      ownedStock(tracked.media).retypedImports.has(
        importStockKey({ namespace: sourceServerKey(), chapter_id: id }),
      )
    )
      return localReaderChapter(number, tracked.media.id, 'volume');
  }
  const data = local
    ? {
        chapter: local.chapter,
        urls: (await cbzPages(local.filename)).map(() => ''),
      }
    : await chapterData(id, signal);
  const chapter = data.chapter;
  const mangaId = chapter.manga?.id ?? 0;
  const number = chapterNumber(chapter.name, chapter.chapterNumber);
  // Pages can stay cached; navigation must use today's persisted source inventory/imports.
  // This also ignores neighbours embedded in older five-minute chapter cache records.
  const tracked = work(mediaId, mangaId);
  const imported = local
    ? (statement('SELECT media_json FROM imported_chapters WHERE chapter_id=? AND namespace=?').get(
        id,
        sourceServerKey(),
      ) as { media_json: string } | undefined)
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
    ...(await navigation(number, tracked?.media ?? importedMedia, mangaId)),
    direction: readerDirection(formatMedia),
    resumePage: position ? Math.min(position.page, data.urls.length - 1) : null,
  };
}
export async function readerPage(request: Request, id: number, index: number) {
  if (id < 0) {
    const row = statement('SELECT media_id,number FROM local_reader_chapters WHERE id=?').get(
      -id,
    ) as { media_id: string; number: number } | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Local chapter not found', 404);
    const local = localIdentity(row.media_id);
    return localReaderPage(request, row.number, local.mediaId, index, local.unit);
  }
  const local = await readerArchive(id);
  if (local) {
    const pages = await cbzPages(local.filename);
    if (!pages[index]) throw new AppError('NOT_FOUND', 'Page not found', 404);
    // Include file identity so a replaced import cannot revive an older cached page.
    const { stat } = await import('node:fs/promises');
    const info = await stat(local.filename);
    return cachedImageResponse(
      request,
      `reader:local:${readerNamespace()}:${id}:${index}:${local.filename}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
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
    chapterId: z
      .number()
      .int()
      .safe()
      .refine((id) => id !== 0),
    number: z.number().finite().nonnegative().nullable(),
    page: z.number().int().min(0).max(1999),
    pageCount: z.number().int().min(1).max(2000),
    commit: z.boolean().optional(),
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
    const local =
      value.chapterId < 0
        ? (statement('SELECT media_id,number FROM local_reader_chapters WHERE id=?').get(
            -value.chapterId,
          ) as { media_id: string; number: number } | undefined)
        : undefined;
    const volume = local?.media_id === `@volume:${value.mediaId}` ? local.number : null;
    statement(
      `UPDATE tracked_media SET volume_read=CASE WHEN ? AND ? IS NOT NULL THEN MAX(COALESCE(volume_read,0),?) ELSE volume_read END WHERE media_json ->> '$.id'=?`,
    ).run(Number(value.page === value.pageCount - 1), volume, volume, value.mediaId);
    statement(
      `UPDATE tracked_media SET status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END,last_read_at=?,last_read=CASE WHEN ? AND ? IS NOT NULL THEN MAX(COALESCE(last_read,0),?) ELSE last_read END WHERE media_json ->> '$.id'=?`,
    ).run(
      now,
      value.page === value.pageCount - 1 ? 1 : 0,
      value.number,
      value.number,
      value.mediaId,
    );
    // A finished source chapter is marked read in Suwayomi too when it is the progress source.
    if (value.page === value.pageCount - 1 && value.chapterId > 0)
      void import('./suwayomi-progress').then((m) => m.markReadInSuwayomi(value.chapterId));
  })();
}
export async function saveReaderProgress(
  value: ReaderProgressUpdate,
  signal?: AbortSignal,
  commit = false,
) {
  const entry = work(value.mediaId, 0);
  const localWork = value.chapterId < 0 ? await localReadingWork(value.mediaId) : undefined;
  if (value.chapterId < 0 && !localWork)
    throw new AppError('NOT_FOUND', 'Local reading work not found', 404);
  const chapter = await readerChapter(
    value.chapterId,
    entry || localWork ? value.mediaId : undefined,
    signal,
  );
  const tracked = entry;
  if (
    !entry &&
    chapter.local === undefined &&
    value.mediaId.startsWith('suwayomi:') &&
    value.mediaId !== `suwayomi:${chapter.mangaId}`
  )
    throw new AppError('NOT_FOUND', 'Reading work does not match this chapter', 404);
  value = {
    ...value,
    chapterId: chapter.chapterId,
    mediaId: entry?.media.id ?? localWork?.media.id ?? value.mediaId,
  };
  if (
    tracked &&
    chapter.local === undefined &&
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
  if (!commit && state.last === signature && Date.now() - state.at < 1000) return;
  state.last = signature;
  state.pending = value;
  if (commit || value.page === value.pageCount - 1 || Date.now() - state.at >= 1000) {
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

export async function localReaderChapter(
  number: number,
  mediaId: string,
  unit: 'chapter' | 'volume' = 'chapter',
  previousSourceId?: number,
): Promise<ReaderChapter> {
  const tracked = await localReadingWork(mediaId);
  if (!tracked) throw new AppError('NOT_FOUND', 'Local reading work not found', 404);
  const archive = await localNumberArchive(tracked.media, number, unit);
  if (!archive) throw new AppError('NOT_FOUND', 'Owned chapter archive not found', 404);
  const pages = await cbzPages(archive.filename);
  const localKey = unit === 'volume' ? `@volume:${tracked.media.id}` : tracked.media.id;
  const identity = statement('SELECT id FROM local_reader_chapters WHERE media_id=? AND number=?');
  let row = identity.get(localKey, number) as { id: number } | undefined;
  if (!row) {
    // An ignored AUTOINCREMENT insert still writes sqlite_sequence. Refreshing is read-only.
    statement('INSERT OR IGNORE INTO local_reader_chapters(media_id,number) VALUES(?,?)').run(
      localKey,
      number,
    );
    row = identity.get(localKey, number) as { id: number };
  }
  const chapterId = -row.id;
  const position = statement(
    'SELECT page FROM reader_progress WHERE media_id=? AND chapter_id=?',
  ).get(tracked.media.id, chapterId) as { page: number } | undefined;
  const previousPosition =
    !position && previousSourceId && unit === 'chapter'
      ? (statement(
          'SELECT page FROM reader_progress WHERE media_id=? AND chapter_id=? AND number=?',
        ).get(tracked.media.id, previousSourceId, number) as { page: number } | undefined)
      : undefined;
  return {
    chapterId,
    mangaId: 0,
    sourceName: '',
    label: `${unit === 'volume' ? 'Volume' : 'Chapter'} ${number}`,
    number: unit === 'volume' ? null : number,
    unit,
    volume: archive.volume,
    local: number,
    ...(await navigation(number, tracked.media, 0, unit)),
    pages: pages.map((_, index) => `/api/reader/page?chapter=${chapterId}&index=${index}`),
    direction: readerDirection(tracked.media),
    resumePage:
      position || previousPosition
        ? Math.min((position ?? previousPosition)!.page, pages.length - 1)
        : null,
  };
}
export async function localReaderPage(
  request: Request,
  number: number,
  mediaId: string,
  index: number,
  unit: 'chapter' | 'volume' = 'chapter',
) {
  const tracked = await localReadingWork(mediaId);
  if (!tracked) throw new AppError('NOT_FOUND', 'Local reading work not found', 404);
  const archive = await localNumberArchive(tracked.media, number, unit);
  if (!archive) throw new AppError('NOT_FOUND', 'Owned chapter archive not found', 404);
  const pages = await cbzPages(archive.filename);
  if (!pages[index]) throw new AppError('NOT_FOUND', 'Page not found', 404);
  const { stat } = await import('node:fs/promises');
  const info = await stat(archive.filename);
  return cachedImageResponse(
    request,
    `reader:owned:${tracked.id}:${number}:${index}:${archive.filename}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
    () => cbzPage(archive.filename, pages[index]),
  );
}
