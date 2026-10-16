import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { dataDir, db, statement } from './db';
import type { CachedImage } from './image-cache';
import { AppError } from './errors';
const directory = () => path.join(/* turbopackIgnore: true */ dataDir, 'covers');
const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
export interface StoredCover {
  tracked_id: number;
  context: string;
  hash: string;
  mime: string;
  filename: string;
  origin_url: string;
}
export function storedCover(id: number): StoredCover | undefined {
  return statement('SELECT * FROM stored_covers WHERE tracked_id=?').get(id) as
    StoredCover | undefined;
}
function filename(cover: StoredCover) {
  if (
    !new RegExp(`^${cover.tracked_id}-[a-f0-9]{16}\\.(jpg|png|webp|gif|avif)$`).test(cover.filename)
  )
    throw new Error('Invalid stored cover');
  return path.join(/* turbopackIgnore: true */ directory(), cover.filename);
}
function remove(file: string) {
  try {
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
export function deleteStoredCoverFile(cover: StoredCover) {
  if (!statement('SELECT 1 FROM stored_covers WHERE filename=?').get(cover.filename))
    remove(filename(cover));
}
export function readStoredCover(cover: StoredCover): CachedImage | null {
  try {
    return { bytes: readFileSync(filename(cover)), mime: cover.mime };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return null;
  }
}
/** Bounded complete bytes, exclusive temp + fsync + rename, then transactional pointer swap. */
export function storeCover(
  id: number,
  context: string,
  originUrl: string,
  image: CachedImage,
  current: () => boolean,
): StoredCover | null {
  const ext = extensions[image.mime.toLowerCase()];
  if (!ext || !image.bytes.length || image.bytes.length > 15 * 1024 * 1024)
    throw new AppError('INVALID_IMAGE', 'Invalid cover bytes', 502);
  const hash = createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
  const cover: StoredCover = {
    tracked_id: id,
    context,
    hash,
    mime: image.mime.toLowerCase(),
    filename: `${id}-${hash}.${ext}`,
    origin_url: originUrl,
  };
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const target = filename(cover);
  const temporary = path.join(/* turbopackIgnore: true */ directory(), `.${randomUUID()}.partial`);
  const old = storedCover(id);
  try {
    if (!existsSync(target)) {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, image.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
    }
    const saved = db().transaction(() => {
      if (!current()) return false;
      statement(
        'INSERT OR REPLACE INTO stored_covers(tracked_id,context,hash,mime,filename,origin_url) VALUES(?,?,?,?,?,?)',
      ).run(id, context, hash, cover.mime, cover.filename, originUrl);
      return true;
    })();
    if (!saved) {
      if (old?.filename !== cover.filename) deleteStoredCoverFile(cover);
      return null;
    }
    if (old && old.filename !== cover.filename) deleteStoredCoverFile(old);
    return cover;
  } finally {
    remove(temporary);
  }
}
export function storedCoverResponse(request: Request, id: number) {
  const cover = storedCover(id);
  const version = new URL(request.url).searchParams.get('v');
  if (!cover || (version !== null && version !== cover.hash))
    throw new AppError('NOT_FOUND', 'Cover not found', 404);
  const etag = `"${cover.hash}"`;
  const headers = {
    'Content-Type': cover.mime,
    ETag: etag,
    'Cache-Control': version
      ? 'private, max-age=31536000, immutable'
      : 'private, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };
  if (
    request.headers
      .get('if-none-match')
      ?.split(',')
      .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
  )
    return new Response(null, { status: 304, headers });
  let fd: number;
  try {
    fd = openSync(filename(cover), 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    throw new AppError('NOT_FOUND', 'Cover not found', 404);
  }
  return new Response(
    Readable.toWeb(
      createReadStream(filename(cover), { fd, autoClose: true }),
    ) as ReadableStream<Uint8Array>,
    { headers },
  );
}
