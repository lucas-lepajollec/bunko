import { cachedImage, suwayomiImageKey } from './image-cache';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantSignal } from './tenant-lifecycle';
import { dataDir } from './db';
import { fetchChapterPages, suwayomiHeaders } from './suwayomi';
import { getSettings } from './settings';
import { endpoint } from './http';
import { AppError } from './errors';
import { eachConcurrent, sharedConcurrencyGate } from './concurrency';
export const MAX_CHAPTER_BYTES = 256 * 1024 * 1024;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const imageExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
export async function boundedBuffer(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AppError('IMPORT_HTTP_ERROR', `Media transfer returned HTTP ${response.status}`, 502);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new AppError('IMPORT_TOO_LARGE', 'Media exceeds size limit', 502);
  }
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw new AppError('IMPORT_TOO_LARGE', 'Media exceeds size limit', 502);
      parts.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts);
}
export async function pageImage(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  return sharedConcurrencyGate(`pages:${dataDir()}`, 3)(async () => {
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const extension = imageExtensions[type];
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('IMPORT_HTTP_ERROR', `Page returned HTTP ${response.status}`, 502);
    }
    if (!extension) {
      await response.body?.cancel();
      throw new AppError('INVALID_IMAGE', 'Page is not a supported image', 502);
    }
    const bytes = await boundedBuffer(response, MAX_PAGE_BYTES);
    if (!bytes.length) throw new AppError('INVALID_IMAGE', 'Page image is empty', 502);
    return { extension, bytes };
  }, signal);
}
export async function chapterPages(
  id: number,
  signal?: AbortSignal,
  progress?: (done: number, total: number, tries: number) => void,
) {
  signal = AbortSignal.any([tenantSignal(), ...(signal ? [signal] : [])]);
  signal.throwIfAborted();
  const urls = await fetchChapterPages(id, signal);
  const pages: { extension: string; bytes: Buffer }[] = new Array(urls.length);
  let done = 0;
  let totalBytes = 0;
  let tries = 0;
  progress?.(0, urls.length, 0);
  await eachConcurrent(
    urls.map((url, index) => ({ url, index })),
    3,
    async ({ url, index }) => {
      signal?.throwIfAborted();
      let page: { extension: string; bytes: Buffer } | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const image = await cachedImage(suwayomiImageKey(`page:${url}`), async () => {
            const loaded = await pageImage(
              endpoint(getSettings().suwayomiUrl, url),
              suwayomiHeaders(),
              signal,
            );
            return {
              bytes: loaded.bytes,
              mime: `image/${loaded.extension === 'jpg' ? 'jpeg' : loaded.extension}`,
            };
          });
          page = { extension: imageExtensions[image.mime], bytes: image.bytes };
          break;
        } catch (e) {
          signal?.throwIfAborted();
          tries++;
          progress?.(done, urls.length, tries);
          if (
            attempt === 2 ||
            (e instanceof AppError && ['INVALID_IMAGE', 'IMPORT_TOO_LARGE'].includes(e.code))
          )
            throw e;
          await delay(250 * 2 ** attempt, undefined, { signal });
        }
      }
      totalBytes += page!.bytes.length;
      if (totalBytes > MAX_CHAPTER_BYTES)
        throw new AppError('IMPORT_TOO_LARGE', 'Chapter exceeds size limit', 502);
      pages[index] = page!;
      progress?.(++done, urls.length, tries);
    },
    signal,
  );
  signal?.throwIfAborted();
  return pages;
}
export async function discardChapterCache(id: number) {
  await rm(path.join(dataDir(), 'page-cache', String(id)), { recursive: true, force: true });
}
