import { afterAll, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-translations-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const tenantRoot = path.join(directory, 'library', '1');
const seriesFolder = path.join(tenantRoot, 'Novels', 'Fixture Novel');
mkdirSync(seriesFolder, { recursive: true });
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, publicSettings } = await import('@/lib/settings');
const translations = await import('@/lib/translations');

const original = 'original english book';
const translated = 'livre traduit en français';
let remoteStatus = 'running';
let uploads: { fields: string; auth: string | undefined }[] = [];
let scans: string[] = [];
let tradocDown = false;
const read = (r: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const server: Server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/tradoc/')) {
    if (tradocDown) return void req.socket.destroy();
    if (req.headers.authorization !== 'Bearer tdk_fixture') return send(401, {});
    const job = {
      id: 'remote1',
      status: remoteStatus,
      progress: { completed: 1, total: 2, percent: remoteStatus === 'completed' ? 100 : 50 },
      external_ref: 'bunko:1:1',
    };
    if (url.pathname === '/tradoc/api/v1/info')
      return send(200, { version: '0.1.8', default: { provider: 'ollama', model: 'qwen' } });
    if (url.pathname === '/tradoc/api/v1/models')
      return send(200, { providers: [{ provider: 'ollama', models: ['qwen'], error: null }] });
    if (url.pathname === '/tradoc/api/v1/translations' && req.method === 'GET')
      return send(200, uploads.length ? [job] : []);
    if (url.pathname === '/tradoc/api/v1/translations' && req.method === 'POST') {
      uploads.push({ fields: await read(req), auth: req.headers.authorization });
      return send(202, job);
    }
    if (url.pathname === '/tradoc/api/v1/translations/remote1') return send(200, job);
    if (url.pathname === '/tradoc/api/v1/translations/remote1/result') {
      res.writeHead(200, { 'Content-Type': 'application/epub+zip' });
      return void res.end(translated);
    }
    return send(404, {});
  }
  if (url.pathname === '/api/Series/volumes')
    return send(200, [
      {
        number: 1,
        chapters: [
          {
            files: [{ filePath: '/books/Novels/Fixture Novel/Fixture Novel v01.epub', bytes: 21 }],
          },
        ],
      },
      { number: 2, chapters: [{ files: [{ filePath: '/books/Novels/Fixture Novel/cover.jpg' }] }] },
    ]);
  if (url.pathname === '/api/Library/scan-folder') {
    scans.push(JSON.parse(await read(req)).folderPath);
    return send(200, {});
  }
  send(404, {});
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const media = { ...emptyMedia('anilist:77', 'Fixture Novel', 'NOVEL'), anilistId: 77 };
const book = path.join(seriesFolder, 'Fixture Novel v01.epub');
let trackedId = 0;

beforeEach(() => {
  db().exec(
    'DELETE FROM translation_jobs; DELETE FROM tracked_media; DELETE FROM kavita_series; DELETE FROM worker_state;',
  );
  rmSync(path.join(tenantRoot, 'Novels'), { recursive: true, force: true });
  mkdirSync(seriesFolder, { recursive: true });
  writeFileSync(book, original);
  updateSettings({
    kavitaUrl: base,
    kavitaApiKey: 'kavita-key',
    kavitaLibraryPath: '/books',
    tradocUrl: `${base}/tradoc/api/v1`,
    tradocApiKey: 'tdk_fixture',
  });
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
  trackedId = track({ media, status: 'READING', kavitaSeriesId: 5 }).id;
  remoteStatus = 'running';
  uploads = [];
  scans = [];
  tradocDown = false;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

const run = () => translations.processTranslations(new AbortController().signal);
const due = () => db().exec('UPDATE translation_jobs SET next_check_at=0');

it('keeps the TraDoc key secret and lists only translatable Kavita files', async () => {
  expect(publicSettings()).not.toHaveProperty('tradocApiKey');
  expect(publicSettings().secretsConfigured.tradocApiKey).toBe(true);
  const files = await translations.translatableFiles(trackedId);
  expect(files).toEqual([
    {
      path: '/books/Novels/Fixture Novel/Fixture Novel v01.epub',
      name: 'Fixture Novel v01.epub',
      volume: 1,
      sizeBytes: 21,
    },
  ]);
  const models = await translations.translationModels();
  expect(models.default).toEqual({ provider: 'ollama', model: 'qwen' });
});

it('replaces the file, keeps the original outside the library and can restore it', async () => {
  const [file] = await translations.translatableFiles(trackedId);
  await translations.requestTranslations({
    trackedId,
    paths: [file.path],
    sourceLang: 'en',
    targetLang: 'fr',
    mode: 'replace',
  });
  await expect(
    translations.requestTranslations({
      trackedId,
      paths: [file.path],
      sourceLang: 'en',
      targetLang: 'fr',
      mode: 'replace',
    }),
  ).rejects.toMatchObject({ code: 'ALREADY_TRANSLATING' });
  await run();
  expect(uploads).toHaveLength(1);
  expect(uploads[0].fields).toContain('original english book');
  expect(uploads[0].fields).toContain('bunko:1:1');
  let [job] = translations.listTranslations(trackedId);
  expect(job).toMatchObject({ state: 'running', progress: 0.5 });

  // A restart before the remote id is stored must not upload twice.
  db().exec("UPDATE translation_jobs SET state='queued', remote_id=NULL");
  await run();
  expect(uploads).toHaveLength(1);

  remoteStatus = 'completed';
  due();
  await run();
  [job] = translations.listTranslations(trackedId);
  expect(job).toMatchObject({ state: 'completed', backup: true });
  expect(readFileSync(book, 'utf8')).toBe(translated);
  expect(scans).toEqual(['/books/Novels/Fixture Novel']);
  const backup = path.join(directory, 'state', 'users', '1', 'translation-backups', String(job.id));
  expect(readFileSync(path.join(backup, 'Fixture Novel v01.epub'), 'utf8')).toBe(original);

  await translations.controlTranslation(job.id, 'restore');
  expect(readFileSync(book, 'utf8')).toBe(original);
  expect(translations.listTranslations(trackedId)[0].state).toBe('restored');
  await translations.controlTranslation(job.id, 'remove');
  expect(existsSync(backup)).toBe(false);
  expect(translations.listTranslations(trackedId)).toEqual([]);
});

it('keeps both as a separate series and retries while TraDoc is unreachable', async () => {
  const [file] = await translations.translatableFiles(trackedId);
  await translations.requestTranslations({
    trackedId,
    paths: [file.path],
    sourceLang: 'en',
    targetLang: 'fr',
    mode: 'separate',
  });
  tradocDown = true;
  await run();
  expect(translations.listTranslations(trackedId)[0]).toMatchObject({
    state: 'queued',
    error: 'TRADOC_UNREACHABLE',
  });
  tradocDown = false;
  due();
  await run();
  remoteStatus = 'completed';
  due();
  await run();
  expect(translations.listTranslations(trackedId)[0].state).toBe('completed');
  expect(readFileSync(book, 'utf8')).toBe(original);
  const copy = path.join(tenantRoot, 'Novels', 'Fixture Novel [FR]', 'Fixture Novel v01.epub');
  expect(readFileSync(copy, 'utf8')).toBe(translated);
  expect(scans).toEqual(['/books/Novels/Fixture Novel [FR]']);
});

it('refuses files that do not belong to the work and manga works', async () => {
  await expect(
    translations.requestTranslations({
      trackedId,
      paths: ['/books/Novels/Other/secret.epub'],
      sourceLang: 'en',
      targetLang: 'fr',
      mode: 'replace',
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  const manga = track({
    media: { ...emptyMedia('anilist:78', 'Fixture Manga', 'MANGA'), anilistId: 78 },
    status: 'READING',
  });
  await expect(translations.translatableFiles(manga.id)).rejects.toMatchObject({
    code: 'UNSUPPORTED_FORMAT',
  });
});
