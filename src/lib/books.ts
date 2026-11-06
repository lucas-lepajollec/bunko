import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { BookFile, BookManifest, BookProgressUpdate, BookTocEntry } from '@/types/shared';
import { listTracked, statement } from './db';
import { AppError } from './errors';
import { assertReadable, localKavitaFile, seriesFiles, type SeriesFile } from './kavita-files';
import { matchKavita } from './kavita-index';
import { tenantState } from './tenant-context';

/**
 * Bunko's own book reader: the EPUB and PDF files of a work in the Kavita library, read from
 * the shared media mount. EPUB chapters are served one by one from the archive (scripts never
 * run: they are stripped and the documents carry a script-free CSP); PDFs are streamed with
 * byte ranges for the in-browser renderer.
 */
const FORMATS = new Set(['.epub', '.pdf']);
const MAX_EPUB = 300 * 1024 * 1024;
const FILES_TTL = 60_000;

export const fileKey = (kavitaPath: string) =>
  createHash('sha256').update(kavitaPath).digest('base64url').slice(0, 16);

const formatOf = (name: string): BookFile['format'] =>
  path.posix.extname(name).toLowerCase() === '.pdf' ? 'pdf' : 'epub';

function trackedFor(mediaId: string) {
  return listTracked().find(
    (t) =>
      t.media.id === mediaId || mediaId === `kavita:${t.kavitaSeriesId ?? t.media.kavitaSeriesId}`,
  );
}

/** The Kavita series holding this work's files, without any metadata call when possible. */
async function seriesFor(mediaId: string, signal?: AbortSignal): Promise<number | null> {
  const tracked = trackedFor(mediaId);
  if (tracked) {
    const series = matchKavita(tracked.media, tracked.kavitaSeriesId);
    if (series) return series.seriesId;
  }
  const direct = /^kavita:([1-9]\d{0,9})$/.exec(mediaId);
  if (direct) return Number(direct[1]);
  const { mediaDetail } = await import('./catalog');
  return (await mediaDetail(mediaId, signal)).kavita?.seriesId ?? null;
}

const fileLists = tenantState(() => new Map<string, { at: number; files: SeriesFile[] }>());
async function filesOf(mediaId: string, signal?: AbortSignal): Promise<SeriesFile[]> {
  const known = fileLists().get(mediaId);
  if (known && Date.now() - known.at < FILES_TTL) return known.files;
  const series = await seriesFor(mediaId, signal);
  const files = series ? await seriesFiles(series, FORMATS, signal) : [];
  fileLists().set(mediaId, { at: Date.now(), files });
  return files;
}

type ProgressRow = {
  file_key: string;
  part: number;
  offset: number;
  fraction: number;
  updated_at: number;
};
const progressOf = (mediaId: string) =>
  new Map(
    (statement('SELECT * FROM book_progress WHERE media_id=?').all(mediaId) as ProgressRow[]).map(
      (r) => [
        r.file_key,
        {
          part: r.part,
          offset: r.offset,
          fraction: r.fraction,
          updatedAt: new Date(r.updated_at).toISOString(),
        },
      ],
    ),
  );

/** The work's readable files, with where the reader stopped in each. */
export async function bookFiles(mediaId: string, signal?: AbortSignal): Promise<BookFile[]> {
  const files = await filesOf(mediaId, signal);
  const progress = progressOf(mediaId);
  return files.map((f) => {
    const key = fileKey(f.path);
    return {
      key,
      name: f.name,
      volume: f.volume,
      format: formatOf(f.name),
      sizeBytes: f.sizeBytes,
      progress: progress.get(key) ?? null,
    };
  });
}

async function resolveFile(mediaId: string, key: string, signal?: AbortSignal) {
  const files = await filesOf(mediaId, signal);
  const index = files.findIndex((f) => fileKey(f.path) === key);
  if (index < 0) throw new AppError('NOT_FOUND', 'Book file not found', 404);
  const local = await localKavitaFile(files[index].path);
  await assertReadable(local, 'book');
  return { file: files[index], local, files, index };
}

// ---------------------------------------------------------------- EPUB archive

interface EpubIndex {
  title: string | null;
  spine: { path: string; weight: number }[];
  toc: BookTocEntry[];
  types: Map<string, string>;
}
interface OpenEpub {
  zip: AdmZip;
  index: EpubIndex;
}
/** A few open archives (by file identity), so page turns do not reread the file. */
const archives = new Map<string, Promise<OpenEpub>>();
async function openEpub(local: string): Promise<OpenEpub> {
  const info = await stat(local);
  if (info.size > MAX_EPUB) throw new AppError('FILE_TOO_LARGE', 'This book is too large', 413);
  const id = `${local}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  let open = archives.get(id);
  if (!open) {
    open = readFile(local).then((bytes) => {
      const zip = new AdmZip(bytes);
      return { zip, index: indexEpub(zip) };
    });
    archives.set(id, open);
    open.catch(() => archives.delete(id));
    while (archives.size > 4) archives.delete(archives.keys().next().value!);
  }
  return open;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}
function attributes(tag: string) {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}
const text = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** An archive path from an href relative to `base` (a folder); null when it leaves the book. */
export function archivePath(base: string, href: string): string | null {
  let target = href.split('#')[0];
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    /* Keep the raw href. */
  }
  const joined = path.posix.normalize(path.posix.join(base, target));
  return joined.startsWith('../') || joined === '..' || joined.startsWith('/') ? null : joined;
}

function entryText(zip: AdmZip, name: string) {
  const entry = zip.getEntry(name);
  return entry ? entry.getData().toString('utf8') : null;
}

export function indexEpub(zip: AdmZip): EpubIndex {
  const container = entryText(zip, 'META-INF/container.xml');
  const opfPath =
    (container && /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1]) ??
    zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.opf'))?.entryName;
  const opf = opfPath ? entryText(zip, opfPath) : null;
  if (!opfPath || !opf) throw new AppError('BOOK_INVALID', 'This EPUB cannot be opened', 422);
  const base = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const manifest = new Map<string, { path: string; type: string; properties: string }>();
  const types = new Map<string, string>();
  for (const m of opf.matchAll(/<(?:opf:)?item\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const target = a.href ? archivePath(base, a.href) : null;
    if (!a.id || !target) continue;
    manifest.set(a.id, {
      path: target,
      type: a['media-type'] ?? '',
      properties: a.properties ?? '',
    });
    if (a['media-type']) types.set(target, a['media-type']);
  }
  const spine: EpubIndex['spine'] = [];
  for (const m of opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const item = a.idref ? manifest.get(a.idref) : undefined;
    const entry = item && zip.getEntry(item.path);
    if (!item || !entry || spine.some((s) => s.path === item.path)) continue;
    spine.push({ path: item.path, weight: Math.max(1, entry.header.size) });
  }
  if (!spine.length) throw new AppError('BOOK_INVALID', 'This EPUB has no readable content', 422);
  const title = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1];
  const part = (file: string) => spine.findIndex((s) => s.path === file);
  // EPUB 3 navigation document first, then the EPUB 2 NCX.
  let toc: BookTocEntry[] = [];
  const nav = [...manifest.values()].find((i) => /\bnav\b/.test(i.properties));
  const navText = nav && entryText(zip, nav.path);
  if (navText) toc = navToc(navText, path.posix.dirname(nav.path), part);
  if (!toc.length) {
    const spineTag = /<(?:opf:)?spine\b[^>]*>/i.exec(opf)?.[0];
    const ncx =
      (spineTag && manifest.get(attributes(spineTag).toc ?? '')) ??
      [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    const ncxText = ncx && entryText(zip, ncx.path);
    if (ncxText) toc = ncxToc(ncxText, path.posix.dirname(ncx.path), part);
  }
  return { title: title ? text(title) || null : null, spine, toc: toc.slice(0, 2000), types };
}

function tocEntry(
  label: string,
  href: string,
  folder: string,
  depth: number,
  part: (p: string) => number,
): BookTocEntry | null {
  const target = archivePath(folder === '.' ? '' : folder, href);
  const index = target === null ? -1 : part(target);
  if (!label || index < 0) return null;
  const anchor = href.includes('#') ? href.slice(href.indexOf('#') + 1) : null;
  return { label: label.slice(0, 300), depth: Math.min(depth, 6), part: index, anchor };
}

function navToc(html: string, folder: string, part: (p: string) => number): BookTocEntry[] {
  const navs = [...html.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)];
  const toc = navs.find((n) => /type\s*=\s*["'][^"']*\btoc\b/i.test(n[1])) ?? navs[0];
  if (!toc) return [];
  const out: BookTocEntry[] = [];
  let depth = -1;
  for (const m of toc[2].matchAll(/<ol\b[^>]*>|<\/ol>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (/^<ol/i.test(m[0])) depth++;
    else if (/^<\/ol/i.test(m[0])) depth--;
    else {
      const entry = tocEntry(
        text(m[2]),
        attributes(`<a ${m[1]}>`).href ?? '',
        folder,
        Math.max(depth, 0),
        part,
      );
      if (entry) out.push(entry);
    }
  }
  return out;
}

function ncxToc(xml: string, folder: string, part: (p: string) => number): BookTocEntry[] {
  const out: BookTocEntry[] = [];
  let depth = -1;
  let label: string | null = null;
  for (const m of xml.matchAll(
    /<navPoint\b[^>]*>|<\/navPoint>|<text\b[^>]*>([\s\S]*?)<\/text>|<content\b[^>]*>/gi,
  )) {
    if (/^<navPoint/i.test(m[0])) {
      depth++;
      label = null;
    } else if (/^<\/navPoint/i.test(m[0])) depth--;
    else if (/^<text/i.test(m[0])) label ??= text(m[1] ?? '');
    else {
      const src = attributes(m[0]).src;
      const entry =
        src && label !== null ? tocEntry(label, src, folder, Math.max(depth, 0), part) : null;
      if (entry) out.push(entry);
      label = null;
    }
  }
  return out;
}

/** Where the reader opens a file: its content order and contents, plus the neighbouring files. */
export async function bookManifest(
  mediaId: string,
  key: string,
  signal?: AbortSignal,
): Promise<BookManifest> {
  const { file, local, files, index } = await resolveFile(mediaId, key, signal);
  const progress = progressOf(mediaId).get(key) ?? null;
  const base = `/api/books/file/${encodeURIComponent(mediaId)}/${key}`;
  const neighbour = (i: number) => (files[i] ? fileKey(files[i].path) : null);
  const common = {
    key,
    name: file.name,
    volume: file.volume,
    url: base,
    progress,
    prevKey: neighbour(index - 1),
    nextKey: neighbour(index + 1),
  };
  if (formatOf(file.name) === 'pdf')
    return { ...common, format: 'pdf', title: null, spine: [], toc: [] };
  const { index: epub } = await openEpub(local);
  return {
    ...common,
    format: 'epub',
    title: epub.title,
    spine: epub.spine.map((s) => ({
      href: `${base}/${s.path.split('/').map(encodeURIComponent).join('/')}`,
      weight: s.weight,
    })),
    toc: epub.toc,
  };
}

const TYPES: Record<string, string> = {
  '.xhtml': 'application/xhtml+xml',
  '.xht': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
/** Book documents may style themselves and load their own images and fonts; nothing runs. */
const BOOK_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'";

/** Removes scripts and inline handlers (the CSP blocks them too). */
export function stripScripts(html: string) {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<(?:iframe|object|embed|base|meta\s+http-equiv)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** One file of an EPUB, or the whole book file when no inner path is given. */
export async function bookResource(request: Request, mediaId: string, key: string, inner: string) {
  const { local, file } = await resolveFile(mediaId, key, request.signal);
  if (!inner) return wholeFile(request, local, file.name);
  if (formatOf(file.name) !== 'epub') throw new AppError('NOT_FOUND', 'Not found', 404);
  const target = archivePath('', inner);
  const { zip, index } = await openEpub(local);
  const entry = target ? zip.getEntry(target) : null;
  if (!target || !entry || entry.isDirectory) throw new AppError('NOT_FOUND', 'Not found', 404);
  const type =
    index.types.get(target) ??
    TYPES[path.posix.extname(target).toLowerCase()] ??
    'application/octet-stream';
  let bytes: Buffer = entry.getData();
  if (/html|xml|svg/.test(type)) bytes = Buffer.from(stripScripts(bytes.toString('utf8')), 'utf8');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': /^(text\/|application\/(xhtml\+)?xml|image\/svg)/.test(type)
        ? `${type}; charset=utf-8`
        : type,
      'Content-Security-Policy': BOOK_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=600',
    },
  });
}

async function wholeFile(request: Request, local: string, name: string) {
  const size = (await stat(local)).size;
  const type = formatOf(name) === 'pdf' ? 'application/pdf' : 'application/epub+zip';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=600',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  const stream = createReadStream(local, { start, end });
  request.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range && (range[1] || range[2]) ? 206 : 200,
    headers,
  });
}

// ---------------------------------------------------------------- progress

/** Where the reader stopped in a file. Finishing a numbered volume counts it as read. */
export async function saveBookProgress(value: BookProgressUpdate, signal?: AbortSignal) {
  const files = await filesOf(value.mediaId, signal);
  const file = files.find((f) => fileKey(f.path) === value.file);
  if (!file) throw new AppError('NOT_FOUND', 'Book file not found', 404);
  const now = Date.now();
  statement(
    `INSERT INTO book_progress(media_id,file_key,part,offset,fraction,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(media_id,file_key) DO UPDATE SET part=excluded.part,offset=excluded.offset,
     fraction=excluded.fraction,updated_at=excluded.updated_at`,
  ).run(value.mediaId, value.file, value.part, value.offset, value.fraction, now);
  const tracked = trackedFor(value.mediaId);
  if (!tracked) return;
  const finished = value.fraction >= 0.995 && file.volume !== null;
  statement(
    `UPDATE tracked_media SET status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END,
     last_read_at=?, volume_read=CASE WHEN ? THEN MAX(COALESCE(volume_read,0),?) ELSE volume_read END
     WHERE id=?`,
  ).run(new Date(now).toISOString(), finished ? 1 : 0, file.volume, tracked.id);
}
