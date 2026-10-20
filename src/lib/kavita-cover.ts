import { readdir, open, link, unlink, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UnifiedMedia } from '@/types/shared';
import type { IndexedSeries } from './kavita-index';
import { mapKavitaPath, safeLibraryDirectory, writableFolder } from './library-paths';
import { boundedBuffer } from './chapter-pages';
import { db, listTracked, getTracked } from './db';
import { coverContext } from './cover-state';
import { endpoint } from './http';
import { getSettings } from './settings';
import { kavitaHeaders, kavitaCoverEndpoint, kavitaAdmin, scanKavitaFolder } from './kavita-client';
import { storedCover, readStoredCover, storeCover } from './stored-covers';
import { imagePath, localImageUrl } from './images';
import { suwayomiHeaders } from './suwayomi';
import { sharedConcurrencyGate } from './concurrency';
import { AppError } from './errors';
import { invalidateKavitaImage, type CachedImage } from './image-cache';
const limit = 15 * 1024 * 1024;
function coverSyncAllowed(seriesId: number) {
  return !listTracked().some(
    (t) =>
      (t.kavitaSeriesId === seriesId || t.media.kavitaSeriesId === seriesId) &&
      t.kavitaCoverSync === false,
  );
}
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
        'books.google.com',
        'static.metron.cloud',
        'metron.cloud',
        'metron-static.nyc3.digitaloceanspaces.com',
        'assets.hardcover.app',
        'thumbnail.image.rakuten.co.jp',
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export async function downloadCover(url: string, parentSignal?: AbortSignal) {
  if (!allowedCoverUrl(url)) return null;
  const response = await fetch(url, {
    signal: AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(15_000)]),
    redirect: 'error',
  });
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!response.ok || !/^image\/(?:jpeg|png|webp|gif|avif)$/i.test(mime)) {
    await response.body?.cancel();
    return null;
  }
  return { bytes: await boundedBuffer(response, limit), mime };
}
async function post(suffix: string, payload: unknown, parentSignal?: AbortSignal) {
  if ((await kavitaAdmin(parentSignal)) === false)
    throw new AppError('KAVITA_NOT_ADMIN', 'Kavita requires an administrator key', 502);
  if (suffix === '/api/Upload/series' && !coverSyncAllowed((payload as { id: number }).id)) return;
  const response = await fetch(endpoint(getSettings().kavitaUrl, suffix), {
    method: 'POST',
    headers: await kavitaHeaders(parentSignal),
    body: JSON.stringify(payload),
    signal: AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(30_000)]),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new AppError(
      response.status === 403 ? 'KAVITA_NOT_ADMIN' : 'KAVITA_COVER_ERROR',
      'Kavita cover request failed',
      502,
    );
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
  return coverGate(() => bootstrapKavitaCover(series, media));
}
async function bootstrapKavitaCover(series: IndexedSeries, media: UnifiedMedia) {
  if (
    !coverSyncAllowed(series.seriesId) ||
    !series.folder ||
    !media.coverUrl ||
    (!allowedCoverUrl(media.coverUrl) && !localImageUrl(media.coverUrl))
  )
    return;
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
    cover = await selectedCover(media.coverUrl);
    if (!cover) return;
    // Persist intent before the filesystem operation, so interruption can retry safely.
    db()
      .prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)')
      .run(key, JSON.stringify({ folder, mime: cover.mime, digest: digest(cover.bytes) }));
    if (!coverSyncAllowed(series.seriesId)) return;
    if (!(await writeCoverFile(local, cover.bytes))) {
      clearPending();
      return;
    }
  }
  const tracked = listTracked().find(
    (t) => t.media.id === media.id && t.coverChoice === 'auto' && t.coverUrl === media.coverUrl,
  );
  if (tracked) {
    const context = coverContext(tracked.media.id, tracked.identity, tracked.coverChoice);
    const previous = storedCover(tracked.id);
    const origin = media.coverUrl.startsWith('/api/covers/')
      ? (previous?.origin_url ?? media.coverUrl)
      : media.coverUrl;
    if (
      !storeCover(tracked.id, context, origin, cover, () => {
        const current = getTracked(tracked.id);
        return Boolean(
          current &&
          coverContext(current.media.id, current.identity, current.coverChoice) === context,
        );
      })
    )
      return;
  }
  if (!coverSyncAllowed(series.seriesId)) return;
  const uploaded = db()
    .prepare('SELECT value FROM worker_state WHERE key=?')
    .get(`kavita_cover_hash:${series.seriesId}`) as { value: string } | undefined;
  if (uploaded?.value !== digest(cover.bytes)) {
    await post('/api/Upload/series', {
      id: series.seriesId,
      url: `data:${cover.mime};base64,${cover.bytes.toString('base64')}`,
      lockCover: true,
    });
    invalidateKavitaImage(series.seriesId);
  }
  db()
    .prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)')
    .run(`kavita_cover_hash:${series.seriesId}`, digest(cover.bytes));
  await scanKavitaFolder(series.folder);
  clearPending();
}

/** Fetch only our two authenticated proxy shapes or an allowlisted catalog host. */
export async function selectedCover(url: string, parentSignal?: AbortSignal) {
  if (allowedCoverUrl(url)) return downloadCover(url, parentSignal);
  if (!localImageUrl(url)) return null;
  const parsed = new URL(url, 'http://bunko.invalid');
  if (parsed.pathname === '/api/metron/cover') {
    const { metronCover } = await import('./metron');
    const artwork = await metronCover(Number(parsed.searchParams.get('seriesId')), parentSignal);
    return artwork && allowedCoverUrl(artwork) ? downloadCover(artwork, parentSignal) : null;
  }
  if (parsed.pathname.startsWith('/api/covers/')) {
    const saved = storedCover(Number(parsed.pathname.split('/').at(-1)));
    return saved && saved.hash === parsed.searchParams.get('v') ? readStoredCover(saved) : null;
  }
  let upstream: string;
  let headers: Record<string, string>;
  const signal = AbortSignal.any([
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(15_000),
  ]);
  if (parsed.pathname === '/api/suwayomi/image') {
    const relative = imagePath(parsed.searchParams.get('path') ?? '');
    upstream = endpoint(getSettings().suwayomiUrl, relative);
    headers = suwayomiHeaders();
  } else if (
    parsed.pathname === '/api/kavita/image' &&
    /^[1-9]\d{0,9}$/.test(parsed.searchParams.get('seriesId') ?? '')
  ) {
    upstream = kavitaCoverEndpoint(parsed.searchParams.get('seriesId')!);
    headers = await kavitaHeaders(signal);
  } else return null;
  const response = await fetch(upstream, { headers, signal, redirect: 'error' });
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!response.ok || !/^image\/(?:jpeg|png|webp|gif|avif)$/i.test(mime)) {
    await response.body?.cancel();
    return null;
  }
  return { bytes: await boundedBuffer(response, limit), mime };
}
const coverGate = sharedConcurrencyGate('cover-sync', 1);
/** Serialize cover writes/uploads across route bundles; byte hashes survive restarts. */
export async function syncSeriesCover(
  series: IndexedSeries,
  url: string,
  current?: () => boolean,
  signal?: AbortSignal,
  fetchedCover?: CachedImage,
) {
  return coverGate(async () => {
    if (!coverSyncAllowed(series.seriesId)) return;
    const cover = fetchedCover ?? (await selectedCover(url, signal));
    if (!cover || !coverSyncAllowed(series.seriesId) || (current && !current())) return;
    const hash = digest(cover.bytes);
    // The sidecar is optional when the series folder is not mounted; API upload still works.
    const local = series.folder ? mapKavitaPath(series.folder) : null;
    if (local && (await writableFolder(local))) {
      const folder = await safeLibraryDirectory(local);
      const target = path.join(folder, 'cover.jpg');
      let oldHash: string | null = null;
      try {
        const file = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (info.isFile() && info.size <= limit) oldHash = digest(await file.readFile());
        } finally {
          await file.close();
        }
      } catch (e) {
        if (!['ENOENT', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      if (oldHash !== hash) {
        const temporary = path.join(folder, `.${randomUUID()}.partial`);
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(cover.bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          if (!coverSyncAllowed(series.seriesId) || (current && !current())) return;
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
        }
      }
    }
    const key = `kavita_cover_hash:${series.seriesId}`;
    const previous = db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
      { value: string } | undefined;
    if (!coverSyncAllowed(series.seriesId) || (current && !current())) return;
    if (previous?.value === hash) {
      if (series.folder) await scanKavitaFolder(series.folder, signal);
      return;
    }
    // Never upload the reader's own cover back to itself.
    if (new URL(url, 'http://bunko.invalid').pathname !== '/api/kavita/image') {
      await post(
        '/api/Upload/series',
        {
          id: series.seriesId,
          url: `data:${cover.mime};base64,${cover.bytes.toString('base64')}`,
          lockCover: true,
        },
        signal,
      );
      invalidateKavitaImage(series.seriesId);
    }
    db().prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(key, hash);
    if (series.folder) await scanKavitaFolder(series.folder, signal);
  }, signal);
}
