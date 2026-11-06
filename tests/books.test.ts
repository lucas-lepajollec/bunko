import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import AdmZip from 'adm-zip';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-books-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const seriesFolder = path.join(directory, 'library', '1', 'Novels', 'Fixture Novel');
mkdirSync(seriesFolder, { recursive: true });
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const books = await import('@/lib/books');

function epub(withNav = true) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(`<?xml version="1.0"?><package><metadata><dc:title>Fixture &amp; Book</dc:title></metadata>
      <manifest>
        ${withNav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item media-type="application/xhtml+xml" id="c1" href="text/chapter%201.xhtml"/>
        <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
        <item id="img" href="images/a.png" media-type="image/png"/>
        <item id="evil" href="../../outside.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="evil"/></spine></package>`),
  );
  zip.addFile(
    'OEBPS/nav.xhtml',
    Buffer.from(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="landmarks"><ol><li><a href="text/chapter2.xhtml">Wrong</a></li></ol></nav>
      <nav epub:type="toc"><ol>
        <li><a href="text/chapter%201.xhtml">Chapter <b>One</b></a>
          <ol><li><a href="text/chapter%201.xhtml#part">Part &#233;</a></li></ol></li>
        <li><a href="text/chapter2.xhtml">Chapter Two</a></li>
      </ol></nav></body></html>`),
  );
  zip.addFile(
    'OEBPS/toc.ncx',
    Buffer.from(`<ncx><navMap>
      <navPoint id="a"><navLabel><text>One (ncx)</text></navLabel><content src="text/chapter%201.xhtml"/>
        <navPoint id="b"><navLabel><text>Inner</text></navLabel><content src="text/chapter%201.xhtml#part"/></navPoint>
      </navPoint>
      <navPoint id="c"><navLabel><text>Two (ncx)</text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
    </navMap></ncx>`),
  );
  zip.addFile(
    'OEBPS/text/chapter 1.xhtml',
    Buffer.from(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><script>alert(1)</script></head><body onload="x()"><p id="part">Hello</p><img src="../images/a.png" onerror="y()"/></body></html>',
    ),
  );
  zip.addFile('OEBPS/text/chapter2.xhtml', Buffer.from('<html><body><p>Two</p></body></html>'));
  zip.addFile('OEBPS/images/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return zip.toBuffer();
}

let volumes: unknown[] = [];
const server: Server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  res.writeHead(url.pathname === '/api/Series/volumes' ? 200 : 404, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(url.pathname === '/api/Series/volumes' ? volumes : {}));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const media = { ...emptyMedia('anilist:88', 'Fixture Novel', 'NOVEL'), anilistId: 88 };
let trackedId = 0;
const fileOf = (name: string) => `/books/Novels/Fixture Novel/${name}`;
const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://bunko${url}`, { headers });

beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM kavita_series; DELETE FROM worker_state; DELETE FROM book_progress;',
  );
  rmSync(seriesFolder, { recursive: true, force: true });
  mkdirSync(seriesFolder, { recursive: true });
  writeFileSync(path.join(seriesFolder, 'Fixture v01.epub'), epub());
  writeFileSync(path.join(seriesFolder, 'Fixture v02.pdf'), Buffer.from('%PDF-1.4 0123456789'));
  volumes = [
    { number: 2, chapters: [{ files: [{ filePath: fileOf('Fixture v02.pdf'), bytes: 19 }] }] },
    {
      number: 1,
      chapters: [
        { files: [{ filePath: fileOf('Fixture v01.epub') }, { filePath: fileOf('cover.jpg') }] },
      ],
    },
  ];
  updateSettings({ kavitaUrl: base, kavitaApiKey: 'kavita-key', kavitaLibraryPath: '/books' });
  db()
    .prepare('INSERT INTO kavita_series VALUES(?,?)')
    .run(
      5,
      JSON.stringify({
        seriesId: 5,
        libraryId: 2,
        libraryName: 'Novels',
        name: 'Fixture Novel',
        names: ['Fixture Novel'],
        folder: '/books/Novels/Fixture Novel',
        numbers: [],
        kind: 'NOVEL',
      }),
    );
  db()
    .prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)')
    .run(
      'kavita_libraries',
      JSON.stringify([
        { id: 2, name: 'Novels', type: 'Book', folders: [{ path: '/books/Novels' }] },
      ]),
    );
  trackedId = track({ media, status: 'PLANNING', kavitaSeriesId: 5 }).id;
});
afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

it('lists the work’s EPUB and PDF files by volume, without other files', async () => {
  const files = await books.bookFiles('anilist:88');
  expect(files.map((f) => [f.name, f.volume, f.format])).toEqual([
    ['Fixture v01.epub', 1, 'epub'],
    ['Fixture v02.pdf', 2, 'pdf'],
  ]);
  expect(files[0].key).toMatch(/^[\w-]{16}$/);
});

it('reads the reading order and the EPUB 3 contents, never leaving the archive', async () => {
  const [first, second] = await books.bookFiles('anilist:88');
  const manifest = await books.bookManifest('anilist:88', first.key);
  expect(manifest.title).toBe('Fixture & Book');
  expect(manifest.spine.map((s) => s.href)).toEqual([
    `/api/books/file/anilist%3A88/${first.key}/OEBPS/text/chapter%201.xhtml`,
    `/api/books/file/anilist%3A88/${first.key}/OEBPS/text/chapter2.xhtml`,
  ]);
  expect(manifest.toc).toEqual([
    { label: 'Chapter One', depth: 0, part: 0, anchor: null },
    { label: 'Part é', depth: 1, part: 0, anchor: 'part' },
    { label: 'Chapter Two', depth: 0, part: 1, anchor: null },
  ]);
  expect([manifest.prevKey, manifest.nextKey]).toEqual([null, second.key]);
  const pdf = await books.bookManifest('anilist:88', second.key);
  expect(pdf).toMatchObject({ format: 'pdf', spine: [], prevKey: first.key, nextKey: null });
});

it('falls back to the EPUB 2 NCX', () => {
  const index = books.indexEpub(new AdmZip(epub(false)));
  expect(index.toc.map((e) => [e.label, e.depth, e.part, e.anchor])).toEqual([
    ['One (ncx)', 0, 0, null],
    ['Inner', 1, 0, 'part'],
    ['Two (ncx)', 0, 1, null],
  ]);
});

it('serves book documents without scripts, under a script-free policy', async () => {
  const [first] = await books.bookFiles('anilist:88');
  const response = await books.bookResource(
    request('/x'),
    'anilist:88',
    first.key,
    'OEBPS/text/chapter 1.xhtml',
  );
  const body = await response.text();
  expect(response.headers.get('content-type')).toContain('application/xhtml+xml');
  expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
  expect(body).not.toMatch(/script|onload|onerror/);
  expect(body).toContain('<p id="part">Hello</p>');
  const image = await books.bookResource(
    request('/x'),
    'anilist:88',
    first.key,
    'OEBPS/images/a.png',
  );
  expect(image.headers.get('content-type')).toBe('image/png');
  for (const bad of ['../../outside.xhtml', 'OEBPS/../../x', 'missing.xhtml'])
    await expect(
      books.bookResource(request('/x'), 'anilist:88', first.key, bad),
    ).rejects.toMatchObject({ status: 404 });
  await expect(
    books.bookResource(request('/x'), 'anilist:88', 'AAAAAAAAAAAAAAAA', 'OEBPS/images/a.png'),
  ).rejects.toMatchObject({ status: 404 });
});

it('streams whole files with byte ranges', async () => {
  const [, pdf] = await books.bookFiles('anilist:88');
  const whole = await books.bookResource(request('/x'), 'anilist:88', pdf.key, '');
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-type')).toBe('application/pdf');
  expect(await whole.text()).toBe('%PDF-1.4 0123456789');
  const part = await books.bookResource(
    request('/x', { range: 'bytes=9-12' }),
    'anilist:88',
    pdf.key,
    '',
  );
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 9-12/19');
  expect(await part.text()).toBe('0123');
  const download = await books.bookResource(request('/x?download=1'), 'anilist:88', pdf.key, '');
  expect(download.headers.get('content-disposition')).toContain('attachment');
  await download.body?.cancel();
});

it('keeps the position per file and counts a finished volume as read', async () => {
  const [first] = await books.bookFiles('anilist:88');
  await books.saveBookProgress({
    mediaId: 'anilist:88',
    file: first.key,
    part: 1,
    offset: 0.5,
    fraction: 0.4,
  });
  expect((await books.bookFiles('anilist:88'))[0].progress).toMatchObject({
    part: 1,
    offset: 0.5,
    fraction: 0.4,
  });
  expect(getTracked(trackedId)).toMatchObject({ status: 'READING' });
  expect(getTracked(trackedId)?.volumeRead ?? null).not.toBe(1);
  await books.saveBookProgress({
    mediaId: 'anilist:88',
    file: first.key,
    part: 1,
    offset: 1,
    fraction: 1,
  });
  expect(db().prepare('SELECT volume_read FROM tracked_media WHERE id=?').get(trackedId)).toEqual({
    volume_read: 1,
  });
  await expect(
    books.saveBookProgress({
      mediaId: 'anilist:88',
      file: 'AAAAAAAAAAAAAAAA',
      part: 0,
      offset: 0,
      fraction: 0,
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it('reads kavita-only works by their series', async () => {
  const files = await books.bookFiles('kavita:5');
  expect(files).toHaveLength(2);
});

it('leaves helpers safe on hostile input', () => {
  expect(books.archivePath('OEBPS', '../../etc/passwd')).toBeNull();
  expect(books.archivePath('', 'https://example.com/x')).toBeNull();
  expect(books.archivePath('OEBPS/text', '../images/a%20b.png#x')).toBe('OEBPS/images/a b.png');
  expect(books.stripScripts('<a onclick="x" href="y">z</a><script src="s"/><iframe src="q">')).toBe(
    '<a href="y">z</a>',
  );
});
