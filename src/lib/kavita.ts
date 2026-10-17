import { currentUser, userContext } from './user-context';
import { progressKey } from './users';
import { open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { db, listTracked, recordImport, manualKavitaLink } from './db';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { chapterNumber } from './suwayomi';
import { AppError } from './errors';
import { kavitaHeaders, scanKavitaFolder } from './kavita-client';
import { selectedCover, hasCoverImage, writeCoverFile } from './kavita-cover';
import { matchKavita } from './kavita-index';
import {
  libraryRoot,
  inside,
  mapKavitaPath,
  safeLibraryDirectory,
  targetFor,
  kavitaPathForLocal,
} from './library-paths';
import { chapterPages, discardChapterCache, MAX_CHAPTER_BYTES } from './chapter-pages';
export { libraryRoot } from './library-paths';
export function xmlEscape(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
export function comicInfo(media: UnifiedMedia, number: number | null, title: string) {
  const fields: Record<string, string> = {
    Series: media.title,
    ...(number !== null ? { Number: String(number) } : { Format: 'Special' }),
    Title: title,
    Summary: (media.synopsis ?? '').replace(/<[^>]+>/g, ''),
    Writer: media.authors.join(', '),
    Genre: media.genres.join(', '),
    Web: media.webUrl ?? '',
    LanguageISO: 'fr',
    Manga: 'Yes',
  };
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${Object.entries(
    fields,
  )
    .map(([k, v]) => `  <${k}>${xmlEscape(v)}</${k}>`)
    .join('\n')}\n</ComicInfo>\n`;
}
export function safeName(value: string, max = 120) {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .trim();
  let result = '';
  for (const character of sanitized) {
    if (Buffer.byteLength(result + character, 'utf8') > max) break;
    result += character;
  }
  return result.replace(/[. ]+$/g, '') || 'series';
}
export function seriesName(media: UnifiedMedia) {
  return safeName(media.title);
}
export async function seriesDirectory(media: UnifiedMedia) {
  const target = targetFor(media);
  const existing = matchKavita(media);
  const local = existing?.folder ? mapKavitaPath(existing.folder) : null;
  const reuse =
    local &&
    inside(target.local, local) &&
    local !== target.local &&
    (target.libraryId === null || target.libraryId === existing?.libraryId);
  return safeLibraryDirectory(
    reuse ? local : path.join(/* turbopackIgnore: true */ target.local, seriesName(media)),
    true,
  );
}
function padded(value: number, digits: number) {
  const [whole, decimal] = String(value).split('.');
  return whole.padStart(digits, '0') + (decimal ? `.${decimal}` : '');
}
export function chapterFilename(
  media: UnifiedMedia,
  chapter: { name: string; chapterNumber: number; volume?: number | null },
) {
  const title = seriesName(media);
  const number = chapterNumber(chapter.name, chapter.chapterNumber);
  if (number === null) return `${title} SP - ${safeName(chapter.name, 80)}.cbz`;
  const namedVolume = chapter.name.match(/(?:vol(?:ume)?\.?|tome)\s*(\d+(?:\.\d+)?)/i);
  const volume = chapter.volume ?? (namedVolume ? Number(namedVolume[1]) : null);
  return `${title}${volume !== null && volume >= 0 ? ` Vol. ${padded(volume, 2)}` : ''} Ch. ${padded(number, 4)}.cbz`;
}
async function atomicWrite(folder: string, name: string, contents: string | Buffer) {
  const tmp = path.join(folder, `.${randomUUID()}.partial`);
  try {
    await writeFile(tmp, contents, { flag: 'wx', mode: 0o600 });
    await rename(tmp, path.join(folder, name));
  } finally {
    await unlink(tmp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
export async function writeMetadata(media: UnifiedMedia) {
  const folder = await seriesDirectory(media);
  await atomicWrite(folder, 'ComicInfo.xml', comicInfo(media, null, media.title));
  if (!media.coverUrl || (await hasCoverImage(folder))) return;
  const cover = await selectedCover(media.coverUrl);
  if (cover) await writeCoverFile(folder, cover.bytes);
}
export function addComicInfo(archive: Buffer, xml: string): Buffer {
  const zip = new AdmZip(archive);
  const entries = zip.getEntries();
  if (entries.reduce((sum, e) => sum + e.header.size, 0) > MAX_CHAPTER_BYTES * 2)
    throw new AppError('UNSAFE_ARCHIVE', 'Archive expands beyond the limit', 502);
  if (!entries.some((e) => /\.(?:jpe?g|png|webp|gif|avif)$/i.test(e.entryName)))
    throw new AppError('INVALID_ARCHIVE', 'Archive contains no chapter pages', 502);
  zip.addFile('ComicInfo.xml', Buffer.from(xml));
  return zip.toBuffer();
}
export async function importChapter(
  media: UnifiedMedia,
  chapter: {
    id: number;
    chapterNumber: number;
    name: string;
    volume?: number | null;
    manga?: { id: number; source?: { id: string; name: string } };
  },
  signal?: AbortSignal,
  progress?: (done: number, total: number, tries: number) => void,
  importing?: () => void,
) {
  const folder = await seriesDirectory(media);
  const pages = await chapterPages(chapter.id, signal, progress);
  signal?.throwIfAborted();
  importing?.();
  const number = chapterNumber(chapter.name, chapter.chapterNumber);
  const zip = new AdmZip();
  for (let index = 0; index < pages.length; index++)
    zip.addFile(
      `${String(index + 1).padStart(4, '0')}.${pages[index].extension}`,
      pages[index].bytes,
    );
  let xml = comicInfo(media, number, chapter.name);
  const volume =
    chapter.volume ?? Number(chapter.name.match(/(?:vol(?:ume)?\.?|tome)\s*(\d+)/i)?.[1] ?? NaN);
  if (Number.isFinite(volume))
    xml = xml.replace('</ComicInfo>', `  <Volume>${volume}</Volume>\n</ComicInfo>`);
  zip.addFile('ComicInfo.xml', Buffer.from(xml));
  // Recheck the directory immediately before writing, including cached/existing folders.
  await safeLibraryDirectory(
    path.join(libraryRoot, path.relative(await realpath(libraryRoot), folder)),
  );
  const target = path.join(folder, chapterFilename(media, chapter));
  const tmp = `${target}.${randomUUID()}.partial`;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(zip.toBuffer());
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await rename(tmp, target);
    recordImport(media, { ...chapter, chapterNumber: number ?? -1 });
  } finally {
    await unlink(tmp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  await discardChapterCache(chapter.id);
}
export async function scanLibrary(media: UnifiedMedia, signal?: AbortSignal) {
  const folder = await seriesDirectory(media);
  const kavitaFolder = kavitaPathForLocal(folder, targetFor(media));
  await scanKavitaFolder(kavitaFolder, signal);
}
const seriesSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  originalName: z.string().nullable().optional(),
  localizedName: z.string().nullable().optional(),
  folderPath: z.string().nullable().optional(),
  lowestFolderPath: z.string().nullable().optional(),
});
const chapterProgressSchema = z.object({
  pages: z.number().nonnegative(),
  pagesRead: z.number().nonnegative(),
  isSpecial: z.boolean().optional(),
  maxNumber: z.number().optional(),
  number: z.union([z.string(), z.number()]).nullable().optional(),
  range: z.string().nullable().optional(),
  lastReadingProgressUtc: z.string().optional(),
  lastReadingProgress: z.string().optional(),
});
export function kavitaProgress(input: unknown): { read: number; lastReadAt: string | null } {
  const volumes = z
    .array(z.object({ chapters: z.array(chapterProgressSchema).nullable() }))
    .parse(input);
  let read = 0;
  let lastReadAt: string | null = null;
  for (const c of volumes.flatMap((v) => v.chapters ?? [])) {
    if (c.pagesRead > 0) {
      const rawDate = c.lastReadingProgressUtc ?? c.lastReadingProgress;
      if (rawDate) {
        const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(rawDate) ? rawDate : `${rawDate}Z`);
        if (
          Number.isFinite(date.getTime()) &&
          date.getUTCFullYear() > 1 &&
          (!lastReadAt || date.toISOString() > lastReadAt)
        )
          lastReadAt = date.toISOString();
      }
    }
    // A partly read chapter is not counted as completed. Specials do not advance numeric progress.
    if (!c.isSpecial && c.pages > 0 && c.pagesRead >= c.pages) {
      const number = c.maxNumber ?? Number(c.number ?? c.range);
      if (Number.isFinite(number) && number >= 0) read = Math.max(read, number);
    }
  }
  return { read, lastReadAt };
}
export async function refreshTrackedProgress(tracked: TrackedMedia, signal?: AbortSignal) {
  if (manualKavitaLink(tracked.id) && tracked.kavitaSeriesId === null) return;
  const user = currentUser();
  const key = user ? progressKey(user.id) : getSettings().kavitaApiKey;
  const s = getSettings();
  if (!s.kavitaUrl || !key) return;
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
  const headers = await kavitaHeaders(bounded, key);
  const get = <T>(suffix: string) =>
    requestJson<T>(endpoint(s.kavitaUrl, suffix), { headers, signal: bounded }, 4000);
  let id = tracked.kavitaSeriesId ?? matchKavita(tracked.media)?.seriesId ?? null;
  if (id === null) {
    const candidates = new Map<number, z.infer<typeof seriesSchema>>();
    for (const query of [seriesName(tracked.media), tracked.title]) {
      const result = await get<unknown>(
        `/api/Search/search?queryString=${encodeURIComponent(query)}&includeChapterAndFiles=false`,
      );
      const hits = z
        .object({ series: z.array(z.object({ seriesId: z.number().int().positive() })).nullable() })
        .parse(result);
      for (const hit of (hits.series ?? []).slice(0, 20)) {
        if (!candidates.has(hit.seriesId))
          candidates.set(
            hit.seriesId,
            seriesSchema.parse(await get(`/api/Series/${hit.seriesId}`)),
          );
      }
      const folder = path.posix.join(s.kavitaLibraryPath, seriesName(tracked.media));
      const exact = [...candidates.values()].filter((c) =>
        [c.folderPath, c.lowestFolderPath].some(
          (p) => p && path.posix.normalize(p).replace(/\/$/, '') === folder,
        ),
      );
      if (exact.length === 1) {
        id = exact[0].id;
        break;
      }
    }
    if (id === null) {
      const normalize = (v: string) => v.normalize('NFKC').toLowerCase().trim();
      const titles = new Set([tracked.title, ...tracked.media.altTitles].map(normalize));
      const matches = [...candidates.values()].filter((c) =>
        [c.name, c.originalName, c.localizedName].some((n) => n && titles.has(normalize(n))),
      );
      if (matches.length === 1) id = matches[0].id;
    }
  }
  if (id === null) return;
  db()
    .prepare(
      'UPDATE tracked_media SET kavita_series_id=? WHERE id=? AND kavita_series_id IS ? AND kavita_manual=0 AND kavita_series_id IS NOT ?',
    )
    .run(id, tracked.id, tracked.kavitaSeriesId, id);
  const progress = kavitaProgress(await get(`/api/Series/volumes?seriesId=${id}`));
  if (user) {
    if (progressKey(user.id) !== key) return;
    db()
      .prepare(
        `UPDATE user_library SET last_read=?,last_read_at=?,progress_checked=1
      WHERE user_id=? AND tracked_id=? AND EXISTS(SELECT 1 FROM tracked_media WHERE id=? AND kavita_series_id IS ?)`,
      )
      .run(progress.read, progress.lastReadAt, user.id, tracked.id, tracked.id, id);
  } else
    db()
      .prepare(
        'UPDATE tracked_media SET last_read=?,last_read_at=?,progress_checked=1 WHERE id=? AND kavita_series_id IS ?',
      )
      .run(progress.read, progress.lastReadAt, tracked.id, id);
}
export async function refreshLibraryProgress(signal?: AbortSignal) {
  if (!currentUser()) {
    const users = db()
      .prepare('SELECT id,username,role FROM users')
      .all() as import('./user-context').Identity[];
    if (users.length) {
      for (const user of users) {
        if (signal?.aborted) break;
        if (progressKey(user.id)) await userContext.run(user, () => refreshLibraryProgress(signal));
      }
      return;
    }
  }
  if (currentUser() && !progressKey(currentUser()!.id)) return;
  // Four requests in flight and a shared total deadline bound on-demand work for large libraries.
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  const queue = listTracked().filter((t) => t.type !== 'ANIME');
  await Promise.allSettled(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && !bounded.aborted) {
        const tracked = queue.shift()!;
        try {
          await refreshTrackedProgress(tracked, bounded);
        } catch {
          /* Keep last successful reading progress. */
        }
      }
    }),
  );
}
