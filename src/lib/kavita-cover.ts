import { readdir, open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UnifiedMedia } from '@/types/shared';
import type { IndexedSeries } from './kavita-index';
import { mapKavitaPath, safeLibraryDirectory, writableFolder } from './library-paths';
import { boundedBuffer } from './chapter-pages';
import { db } from './db';
import { endpoint } from './http';
import { getSettings } from './settings';
import { kavitaHeaders } from './kavita-client';
import { AppError } from './errors';
const limit = 15 * 1024 * 1024;
export function allowedCoverUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        's4.anilist.co',
        's3.anilist.co',
        'uploads.mangadex.org',
        'cdn.mangaupdates.com',
        'www.mangaupdates.com',
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export async function downloadCover(url: string) {
  if (!allowedCoverUrl(url)) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!response.ok || !/^image\/(?:jpeg|png|webp|gif|avif)$/i.test(mime)) {
    await response.body?.cancel();
    return null;
  }
  return { bytes: await boundedBuffer(response, limit), mime };
}
async function post(suffix: string, payload: unknown) {
  const response = await fetch(endpoint(getSettings().kavitaUrl, suffix), {
    method: 'POST',
    headers: await kavitaHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new AppError('KAVITA_SCAN_ERROR', 'Kavita cover/scan request failed', 502);
}
export async function hasCoverImage(folder: string) {
  return (await readdir(folder)).some((n) =>
    /^(cover|folder)\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(n),
  );
}
/** Publish a complete sidecar atomically without replacing a user file. */
export async function writeCoverFile(folder: string, bytes: Buffer) {
  const actual = await safeLibraryDirectory(folder);
  const temporary = path.join(actual, `.${randomUUID()}.partial`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (await hasCoverImage(actual)) return false;
    try {
      await link(temporary, path.join(actual, 'cover.jpg'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Sidecars are retained for portability; Kavita uses Upload/series, not the sidecar. */
export async function ensureKavitaCover(series: IndexedSeries, media: UnifiedMedia) {
  if (!series.folder || !media.coverUrl || !allowedCoverUrl(media.coverUrl)) return;
  const local = mapKavitaPath(series.folder);
  if (!local || !(await writableFolder(local))) return;
  const folder = await safeLibraryDirectory(local);
  const key = `kavita_cover_pending:${series.seriesId}`;
  const clearPending = () => db().prepare('DELETE FROM worker_state WHERE key=?').run(key);
  const pending = db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
    { value: string } | undefined;
  let cover: { bytes: Buffer; mime: string } | null = null;
  if (pending) {
    const state = JSON.parse(pending.value) as { folder: string; mime: string; digest: string };
    if (state.folder !== folder) return;
    let file;
    try {
      file = await open(path.join(folder, 'cover.jpg'), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (file) {
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > limit) return;
        const bytes = await file.readFile();
        // A user replaced the pending cover: preserve that choice and abandon our upload.
        if (digest(bytes) !== state.digest) {
          clearPending();
          return;
        }
        cover = { bytes, mime: state.mime };
      } finally {
        await file.close();
      }
    }
  }
  if (!cover) {
    if (await hasCoverImage(folder)) return;
    cover = await downloadCover(media.coverUrl);
    if (!cover) return;
    // Persist intent before the filesystem operation, so interruption can retry safely.
    db()
      .prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)')
      .run(key, JSON.stringify({ folder, mime: cover.mime, digest: digest(cover.bytes) }));
    if (!(await writeCoverFile(local, cover.bytes))) {
      clearPending();
      return;
    }
  }
  await post('/api/Upload/series', {
    id: series.seriesId,
    url: `data:${cover.mime};base64,${cover.bytes.toString('base64')}`,
    lockCover: true,
  });
  await post('/api/Library/scan-folder', { folderPath: series.folder });
  clearPending();
}
