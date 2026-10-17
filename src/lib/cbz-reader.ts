import { open } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { AppError } from './errors';
const inflate = promisify(inflateRaw);
export interface ZipPage {
  name: string;
  offset: number;
  compressed: number;
  size: number;
  method: number;
}
const invalid = () => new AppError('INVALID_ARCHIVE', 'Chapter archive is invalid', 502);
/** Read the central directory and one page, without loading/decompressing the whole CBZ. */
export async function cbzPages(filename: string): Promise<ZipPage[]> {
  const file = await open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = tail.length - 22;
    for (; end >= 0; end--)
      if (
        tail.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length
      )
        break;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw invalid();
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count > 4000 || length > 4 * 1024 * 1024 || offset + length > size) throw invalid();
    const directory = Buffer.alloc(length);
    if ((await file.read(directory, 0, length, offset)).bytesRead !== length) throw invalid();
    const pages: ZipPage[] = [];
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > length || directory.readUInt32LE(at) !== 0x02014b50) throw invalid();
      const nameSize = directory.readUInt16LE(at + 28);
      const extra = directory.readUInt16LE(at + 30);
      const comment = directory.readUInt16LE(at + 32);
      if (at + 46 + nameSize + extra + comment > length) throw invalid();
      const name = directory.subarray(at + 46, at + 46 + nameSize).toString('utf8');
      if (/\.(jpe?g|png|webp|gif|avif)$/i.test(name) && !name.startsWith('__MACOSX/')) {
        const entry = {
          name,
          method: directory.readUInt16LE(at + 10),
          compressed: directory.readUInt32LE(at + 20),
          size: directory.readUInt32LE(at + 24),
          offset: directory.readUInt32LE(at + 42),
        };
        if (
          directory.readUInt16LE(at + 8) & 1 ||
          ![0, 8].includes(entry.method) ||
          entry.size > 20 * 1024 * 1024 ||
          entry.compressed > 21 * 1024 * 1024 ||
          entry.offset + entry.compressed > size
        )
          throw invalid();
        pages.push(entry);
      }
      at += 46 + nameSize + extra + comment;
    }
    if (!pages.length || pages.length > 2000) throw invalid();
    return pages.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  } finally {
    await file.close();
  }
}
export async function cbzPage(filename: string, page: ZipPage) {
  const file = await open(filename, 'r');
  try {
    const header = Buffer.alloc(30);
    if (
      (await file.read(header, 0, 30, page.offset)).bytesRead !== 30 ||
      header.readUInt32LE(0) !== 0x04034b50
    )
      throw invalid();
    const start = page.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = Buffer.alloc(page.compressed);
    if ((await file.read(compressed, 0, compressed.length, start)).bytesRead !== compressed.length)
      throw invalid();
    const bytes =
      page.method === 8
        ? await inflate(compressed, { maxOutputLength: 20 * 1024 * 1024 })
        : compressed;
    if (!bytes.length || bytes.length !== page.size) throw invalid();
    const extension = page.name.split('.').pop()!.toLowerCase();
    return { bytes, mime: `image/${extension === 'jpg' ? 'jpeg' : extension}` };
  } finally {
    await file.close();
  }
}
