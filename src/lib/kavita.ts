import { mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { db, listTracked, recordImport } from './db';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { chapterNumber, suwayomiHeaders } from './suwayomi';
import { AppError } from './errors';
export const libraryRoot = path.resolve(
  /* turbopackIgnore: true */ process.env.KAVISEERR_LIBRARY_DIR ?? './media',
);
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
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
    ...(number !== null ? { Number: String(number) } : {}),
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
export function seriesName(media: UnifiedMedia) {
  return `${
    media.title
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 120) || 'series'
  }-${createHash('sha256').update(media.id).digest('hex').slice(0, 10)}`;
}
export async function seriesDirectory(media: UnifiedMedia) {
  await mkdir(libraryRoot, { recursive: true });
  const root = await realpath(/* turbopackIgnore: true */ libraryRoot);
  const folder = path.join(root, seriesName(media));
  await mkdir(folder, { recursive: true });
  const actual = await realpath(folder);
  if (path.dirname(actual) !== root)
    throw new AppError('UNSAFE_PATH', 'Series folder escapes library', 400);
  return actual;
}
async function boundedBuffer(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AppError('IMPORT_HTTP_ERROR', 'Media transfer failed', 502);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new AppError('IMPORT_TOO_LARGE', 'Media exceeds import size limit', 502);
  }
  const reader = response.body.getReader();
  const buffers: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit)
        throw new AppError('IMPORT_TOO_LARGE', 'Media exceeds import size limit', 502);
      buffers.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(buffers);
}
export async function writeMetadata(media: UnifiedMedia) {
  const folder = await seriesDirectory(media);
  await writeFile(path.join(folder, 'ComicInfo.xml'), comicInfo(media, null, media.title), {
    mode: 0o600,
  });
  if (media.coverUrl) {
    // Only fetch covers from the metadata providers, never a client-supplied arbitrary URL.
    const url = new URL(media.coverUrl);
    if (
      url.protocol !== 'https:' ||
      ![
        's4.anilist.co',
        's3.anilist.co',
        'uploads.mangadex.org',
        'cdn.mangaupdates.com',
        'www.mangaupdates.com',
      ].includes(url.hostname)
    )
      return;
    const image = await boundedBuffer(
      await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' }),
      15 * 1024 * 1024,
    );
    await writeFile(path.join(folder, 'cover.jpg'), image, { mode: 0o600 });
  }
}
export function addComicInfo(archive: Buffer, xml: string): Buffer {
  const zip = new AdmZip(archive);
  const entries = zip.getEntries();
  if (entries.reduce((sum, e) => sum + e.header.size, 0) > MAX_ARCHIVE_BYTES * 2)
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
    manga?: { id: number; source?: { id: string; name: string } };
  },
) {
  const folder = await seriesDirectory(media);
  const number = chapterNumber(chapter.name, chapter.chapterNumber);
  const target = path.join(folder, `Ch-${number ?? 'special'}-${chapter.id}.cbz`);
  const tmp = `${target}.partial`;
  const response = await fetch(
    endpoint(getSettings().suwayomiUrl, `/api/v1/chapter/${chapter.id}/download`),
    { headers: suwayomiHeaders(), signal: AbortSignal.timeout(120_000), redirect: 'error' },
  );
  const archive = addComicInfo(
    await boundedBuffer(response, MAX_ARCHIVE_BYTES),
    comicInfo(media, number, chapter.name),
  );
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(archive);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  recordImport(media, { ...chapter, chapterNumber: number ?? -1 });
}
export async function scanLibrary(media: UnifiedMedia) {
  const s = getSettings();
  const headers = await kavitaHeaders();
  const response = await fetch(endpoint(s.kavitaUrl, '/api/Library/scan-folder'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ folderPath: path.posix.join(s.kavitaLibraryPath, seriesName(media)) }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new AppError('KAVITA_SCAN_ERROR', `Kavita scan returned HTTP ${response.status}`, 502);
}

async function kavitaHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
  const s = getSettings();
  if (!s.kavitaUrl || !s.kavitaApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Kavita is not configured', 409);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.kavitaAuthMode === 'jwt') {
    const authUrl = new URL(endpoint(s.kavitaUrl, '/api/Plugin/authenticate'));
    authUrl.searchParams.set('apiKey', s.kavitaApiKey);
    authUrl.searchParams.set('pluginName', 'KaviSeerr');
    const auth = await requestJson<{ token: string }>(authUrl, { method: 'POST', signal });
    if (!auth.token) throw new AppError('KAVITA_AUTH_ERROR', 'Kavita authentication failed', 502);
    headers.Authorization = `Bearer ${auth.token}`;
  } else headers['x-api-key'] = s.kavitaApiKey;
  return headers;
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
  const s = getSettings();
  if (!s.kavitaUrl || !s.kavitaApiKey) return;
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
  const headers = await kavitaHeaders(bounded);
  const get = <T>(suffix: string) =>
    requestJson<T>(endpoint(s.kavitaUrl, suffix), { headers, signal: bounded }, 4000);
  let id = tracked.kavitaSeriesId;
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
    .prepare('UPDATE tracked_media SET kavita_series_id=? WHERE id=? AND kavita_series_id IS ?')
    .run(id, tracked.id, tracked.kavitaSeriesId);
  const progress = kavitaProgress(await get(`/api/Series/volumes?seriesId=${id}`));
  db()
    .prepare(
      'UPDATE tracked_media SET last_read=?,last_read_at=?,progress_checked=1 WHERE id=? AND kavita_series_id IS ?',
    )
    .run(progress.read, progress.lastReadAt, tracked.id, id);
}
export async function refreshLibraryProgress(signal?: AbortSignal) {
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
