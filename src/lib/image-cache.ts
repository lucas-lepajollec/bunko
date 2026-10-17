import { sourceServerKey } from './source-server';
import { tenantState } from './tenant-context';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  readSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { mkdir, open, rename, unlink, readdir, stat } from 'node:fs/promises';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { tenantSignal } from './tenant-lifecycle';
import path from 'node:path';
import { Readable } from 'node:stream';
import { statement, dataDir } from './db';
import { getSettings } from './settings';
import { boundedBuffer } from './chapter-pages';
import { AppError } from './errors';

export interface CachedImage {
  bytes: Buffer;
  mime: string;
  etag?: string;
}
const DAY = 86_400_000;
const directory = () => path.join(/* turbopackIgnore: true */ dataDir(), 'cache', 'images');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const scope = globalThis as typeof globalThis & {
  __bunkoImageLoads?: Map<string, { promise: Promise<CachedImage>; invalidated: boolean }>;
};
const loads = (scope.__bunkoImageLoads ??= new Map());
export function kavitaImageKey(seriesId: string | number) {
  const s = getSettings();
  return `kavita:${hash(JSON.stringify([s.kavitaUrl, s.kavitaApiKey, s.kavitaAuthMode]))}:${seriesId}`;
}
export function suwayomiImageKey(relative: string) {
  return `${sourceServerKey()}:${relative}`;
}
const filename = (key: string) => path.join(/* turbopackIgnore: true */ directory(), key);
function remove(key: string) {
  diskHeaders().delete(key);
  statement('DELETE FROM image_cache WHERE key=?').run(key);
  try {
    unlinkSync(filename(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
/** In-flight responses from before an upload must not repopulate the invalidated cache. */
export function invalidateImage(key: string) {
  const digest = hash(key);
  const pending = loads.get(`${dataDir()}:${digest}`);
  if (pending) {
    pending.invalidated = true;
    loads.delete(`${dataDir()}:${digest}`);
  }
  remove(digest);
}
export function invalidateKavitaImage(seriesId: number) {
  invalidateImage(kavitaImageKey(seriesId));
}
const MAX_BYTES = 500 * 1024 * 1024;
const maintenance = tenantState(() => ({ pending: false, reconciled: 0 }));
export function imageCacheBytes() {
  return (
    statement("SELECT bytes FROM cache_usage WHERE name='image_cache'").get() as { bytes: number }
  ).bytes;
}
/** Explicit maintenance is async. Normal publication only schedules it after the byte threshold. */
export async function pruneImages(maxBytes = MAX_BYTES, reconcile = true) {
  const signal = tenantSignal();
  while (!signal.aborted && imageCacheBytes() > maxBytes) {
    const rows = statement(
      'SELECT key,bytes,accessed_at FROM image_cache ORDER BY accessed_at,key LIMIT 32',
    ).all() as { key: string; bytes: number; accessed_at: number }[];
    let removed = 0;
    for (const row of rows) {
      if (imageCacheBytes() <= maxBytes || signal.aborted) break;
      if (loads.has(`${dataDir()}:${row.key}`)) continue;
      await unlink(filename(row.key)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      statement('DELETE FROM image_cache WHERE key=? AND accessed_at=? AND bytes=?').run(
        row.key,
        row.accessed_at,
        row.bytes,
      );
      diskHeaders().delete(row.key);
      removed++;
    }
    if (!removed) break;
    await yieldIO();
  }
  if (!reconcile || signal.aborted) return;
  // Crash leftovers are reconciled at most daily, using async IO in small batches.
  const files = await readdir(directory()).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  for (let i = 0; i < files.length && !signal.aborted; i++) {
    const key = files[i];
    if (loads.has(`${dataDir()}:${key}`)) continue;
    if (/^[a-f0-9]{64}$/.test(key) && !statement('SELECT 1 FROM image_cache WHERE key=?').get(key))
      await unlink(filename(key)).catch(() => {});
    else if (
      /^\.[a-f0-9-]+\.partial$/.test(key) &&
      Date.now() - (await stat(filename(key))).mtimeMs > 3_600_000
    )
      await unlink(filename(key)).catch(() => {});
    if (i % 32 === 31) await yieldIO();
  }
}
function schedulePrune() {
  const state = maintenance();
  const reconcile = Date.now() - state.reconciled >= DAY;
  if (state.pending || (!reconcile && imageCacheBytes() <= MAX_BYTES)) return;
  state.pending = true;
  state.reconciled = Date.now();
  const timer = setTimeout(() => {
    void pruneImages(Math.floor(MAX_BYTES * 0.9), reconcile)
      .catch(() => {})
      .finally(() => {
        state.pending = false;
        try {
          if (!tenantSignal().aborted && imageCacheBytes() > MAX_BYTES) schedulePrune();
        } catch {
          /* Tenant removed during maintenance. */
        }
      });
  }, 25);
  timer.unref();
}
function read(key: string): (CachedImage & { at: number }) | null {
  try {
    const packed = readFileSync(filename(key));
    const newline = packed.indexOf(10);
    if (newline < 0 || newline > 512) throw new Error('Invalid cache header');
    const meta = JSON.parse(packed.subarray(0, newline).toString()) as {
      mime: string;
      at: number;
      etag?: string;
    };
    if (
      !/^image\/(?:jpeg|png|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/.test(meta.mime) ||
      !Number.isFinite(meta.at)
    )
      throw new Error('Invalid cache metadata');
    statement(
      `INSERT INTO image_cache(key,bytes,accessed_at,attempted_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET accessed_at=excluded.accessed_at`,
    ).run(key, packed.length, Date.now(), meta.at);
    return { bytes: packed.subarray(newline + 1), mime: meta.mime, at: meta.at, etag: meta.etag };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') remove(key);
    else statement('DELETE FROM image_cache WHERE key=?').run(key);
    return null;
  }
}
async function write(key: string, image: CachedImage, valid: () => boolean) {
  const signal = tenantSignal();
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const temporary = path.join(/* turbopackIgnore: true */ directory(), `.${randomUUID()}.partial`);
  const packed = Buffer.concat([
    Buffer.from(
      JSON.stringify({ mime: image.mime, at: Date.now(), etag: `"${hash(image.bytes)}"` }) + '\n',
    ),
    image.bytes,
  ]);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(packed);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!valid() || signal.aborted) return;
    await rename(temporary, filename(key));
    if (!valid() || signal.aborted) {
      await unlink(filename(key)).catch(() => {});
      return;
    }
    diskHeaders().delete(key);
    statement(`INSERT INTO image_cache(key,bytes,accessed_at,attempted_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,accessed_at=excluded.accessed_at,attempted_at=excluded.attempted_at`).run(
      key,
      packed.length,
      Date.now(),
      Date.now(),
    );
    schedulePrune();
  } finally {
    await unlink(temporary).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
export async function cachedImage(
  key: string,
  load: () => Promise<CachedImage>,
): Promise<CachedImage> {
  const digest = hash(key);
  const pendingKey = `${dataDir()}:${digest}`;
  const hit = read(digest);
  const refresh = () => {
    let pending = loads.get(pendingKey);
    if (!pending) {
      pending = {
        invalidated: false,
        promise: Promise.resolve()
          .then(load)
          .then(async (image) => {
            if (!pending!.invalidated) await write(digest, image, () => !pending!.invalidated);
            return image;
          })
          .finally(() => {
            if (loads.get(pendingKey) === pending) loads.delete(pendingKey);
          }),
      };
      loads.set(pendingKey, pending);
    }
    return pending.promise;
  };
  if (hit) {
    if (
      Date.now() - hit.at >= DAY &&
      statement('UPDATE image_cache SET attempted_at=? WHERE key=? AND attempted_at<=?').run(
        Date.now(),
        digest,
        Date.now() - DAY,
      ).changes
    )
      void refresh().catch(() => {
        /* Keep serving the last complete image, even after upstream failures. */
      });
    return hit;
  }
  return refresh();
}
export async function fetchImage(
  url: string,
  headers: Record<string, string>,
  max = 15 * 1024 * 1024,
  icons = false,
  signal = AbortSignal.timeout(15_000),
): Promise<CachedImage> {
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (
    !response.ok ||
    !(
      icons
        ? /^image\/(?:jpeg|png|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/
        : /^image\/(?:jpeg|png|gif|webp|avif)$/
    ).test(mime)
  ) {
    await response.body?.cancel();
    throw new AppError('INVALID_IMAGE', 'Upstream image unavailable', 502);
  }
  return { bytes: await boundedBuffer(response, max), mime };
}
export function imageResponse(request: Request, image: CachedImage) {
  const etag = image.etag ?? `"${hash(image.bytes)}"`;
  const headers = {
    Vary: 'Cookie, Authorization',
    'Content-Type': image.mime,
    ETag: etag,
    'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
    'X-Content-Type-Options': 'nosniff',
  };
  const matches = request.headers
    .get('if-none-match')
    ?.split(',')
    .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
  return new Response(matches ? null : new Uint8Array(image.bytes), {
    status: matches ? 304 : 200,
    headers,
  });
}

type DiskHeader = {
  mime: string;
  at: number;
  etag: string;
  start: number;
  mtime: number;
  size: number;
  touched: number;
  attempted: number;
};
const diskHeaders = tenantState(() => new Map<string, DiskHeader>());
/** Hot proxy hits open a file stream; payload hashing happens only on publication. */
export async function cachedImageResponse(
  request: Request,
  key: string,
  load: () => Promise<CachedImage>,
): Promise<Response> {
  const digest = hash(key);
  let header = diskHeaders().get(digest);
  try {
    const info = statSync(filename(digest));
    if (!header || header.mtime !== info.mtimeMs || header.size !== info.size) {
      const fd = openSync(filename(digest), 'r');
      const prefix = Buffer.alloc(512);
      let length: number;
      try {
        length = readSync(fd, prefix, 0, 512, 0);
      } finally {
        closeSync(fd);
      }
      const newline = prefix.subarray(0, length).indexOf(10);
      if (newline < 0) throw new Error('Invalid image header');
      const meta = JSON.parse(prefix.subarray(0, newline).toString()) as DiskHeader;
      // Legacy packed files upgrade on their next daily refresh; hash once per process meanwhile.
      const etag = meta.etag ?? `"${hash(readFileSync(filename(digest)).subarray(newline + 1))}"`;
      if (
        !/^image\/(?:jpeg|png|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/.test(meta.mime) ||
        !Number.isFinite(meta.at) ||
        !/^"[a-f0-9]{64}"$/.test(etag)
      )
        throw new Error('Invalid image header');
      const row = statement('SELECT attempted_at FROM image_cache WHERE key=?').get(digest) as
        { attempted_at: number } | undefined;
      header = {
        ...meta,
        etag,
        start: newline + 1,
        mtime: info.mtimeMs,
        size: info.size,
        touched: 0,
        attempted: row?.attempted_at ?? 0,
      };
      if (diskHeaders().size >= 1000) diskHeaders().clear();
      diskHeaders().set(digest, header);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') remove(digest);
    const image = await cachedImage(key, load);
    return imageResponse(request, image);
  }
  if (Date.now() - header.touched >= 60_000) {
    statement(`INSERT INTO image_cache(key,bytes,accessed_at,attempted_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET accessed_at=excluded.accessed_at`).run(
      digest,
      header.size,
      Date.now(),
      header.at,
    );
    header.touched = Date.now();
  }
  if (Date.now() - header.at >= DAY && Date.now() - header.attempted >= DAY) {
    header.attempted = Date.now();
    void cachedImage(key, load).catch(() => {
      /* Retain last complete bytes. */
    });
  }
  const headers = {
    Vary: 'Cookie, Authorization',
    'Content-Type': header.mime,
    ETag: header.etag,
    'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
    'X-Content-Type-Options': 'nosniff',
  };
  const matches = request.headers
    .get('if-none-match')
    ?.split(',')
    .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === header.etag);
  if (matches) return new Response(null, { status: 304, headers });
  try {
    const fd = openSync(filename(digest), 'r');
    return new Response(
      Readable.toWeb(
        createReadStream(filename(digest), { fd, autoClose: true, start: header.start }),
      ) as ReadableStream<Uint8Array>,
      { headers },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return imageResponse(request, await cachedImage(key, load));
  }
}
