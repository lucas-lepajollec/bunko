import { tenantState } from './tenant-context';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  readSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
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
  const s = getSettings();
  return `suwayomi:${hash(JSON.stringify([s.suwayomiUrl, s.suwayomiUsername, s.suwayomiPassword]))}:${relative}`;
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
/** Includes orphaned files left by a crash between atomic publication and SQLite update. */
export function pruneImages(maxBytes = 500 * 1024 * 1024) {
  if (!existsSync(directory())) return;
  const rows = statement('SELECT key,accessed_at FROM image_cache').all() as {
    key: string;
    accessed_at: number;
  }[];
  const access = new Map(rows.map((r) => [r.key, r.accessed_at]));
  for (const file of readdirSync(directory())) {
    if (
      /^\.[a-f0-9-]+\.partial$/.test(file) &&
      Date.now() - statSync(path.join(directory(), file)).mtimeMs > 3_600_000
    )
      unlinkSync(path.join(directory(), file));
  }
  const files = readdirSync(directory())
    .filter((key) => /^[a-f0-9]{64}$/.test(key))
    .map((key) => ({ key, bytes: statSync(filename(key)).size, at: access.get(key) ?? 0 }));
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  files.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  for (const file of files) {
    if (total <= maxBytes && access.has(file.key)) continue;
    remove(file.key);
    total -= file.bytes;
  }
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
function write(key: string, image: CachedImage) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const temporary = path.join(/* turbopackIgnore: true */ directory(), `.${randomUUID()}.partial`);
  const packed = Buffer.concat([
    Buffer.from(
      JSON.stringify({ mime: image.mime, at: Date.now(), etag: `"${hash(image.bytes)}"` }) + '\n',
    ),
    image.bytes,
  ]);
  try {
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, packed);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, filename(key));
    diskHeaders().delete(key);
    statement(
      'INSERT OR REPLACE INTO image_cache(key,bytes,accessed_at,attempted_at) VALUES(?,?,?,?)',
    ).run(key, packed.length, Date.now(), Date.now());
    pruneImages();
  } finally {
    try {
      unlinkSync(temporary);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
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
          .then((image) => {
            if (!pending!.invalidated) write(digest, image);
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
