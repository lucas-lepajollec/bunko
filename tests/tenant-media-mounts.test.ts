import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-mounts-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'data');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant } = await import('@/lib/tenant-context');
const { closeTenant } = await import('@/lib/db');
const { getSettings, updateSettings, persistentSecret } = await import('@/lib/settings');
const { libraryRoot, mapKavitaPath, safeLibraryDirectory, targetFor, resolveLibraryFolder } =
  await import('@/lib/library-paths');
const { importChapter, scanLibrary, writeMetadata } = await import('@/lib/kavita');
const { emptyMedia } = await import('@/lib/media');
const { GET } = await import('@/app/api/kavita/status/route');
const media = { ...emptyMedia('anilist:1', 'Legacy Story', 'MANGA'), format: 'MANGA' as const };
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(directory, 'library-'));
  process.env.BUNKO_LIBRARY_DIR = root;
  accountsDb().prepare("UPDATE users SET username='Lucas' WHERE id=1").run();
  accountsDb()
    .prepare(
      `INSERT OR REPLACE INTO users(id,username,role,password_hash,session_epoch,created_at)
    VALUES(2,'Alice','member','fixture','fixture','2026-01-01')`,
    )
    .run();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});
const status = async () => {
  const token = persistentSecret('access.token', 32).toString('hex');
  const response = await GET(
    new Request('http://fixture.test/api/kavita/status', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
};
it('keeps legacy downloads, metadata and scan paths working without changing the mount', async () => {
  mkdirSync(path.join(root, 'Manga'));
  updateSettings({
    suwayomiUrl: 'http://pages.test',
    kavitaUrl: 'http://kavita.test',
    kavitaApiKey: 'fixture',
    libraryTargets: { MANGA: { libraryId: 1, folder: '/medias/Manga' } },
  });
  const scans: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/graphql'))
        return Response.json({
          data: { fetchChapterPages: { pages: ['/api/v1/manga/1/chapter/0/page/0'] } },
        });
      if (url.endsWith('/api/Library/scan-folder')) {
        scans.push(JSON.parse(String(init?.body)).folderPath);
        return new Response(null, { status: 200 });
      }
      return new Response('fixture-page', { headers: { 'Content-Type': 'image/png' } });
    }),
  );
  expect(libraryRoot()).toBe(root);
  expect(getSettings().kavitaLibraryPath).toBe('/library');
  expect(targetFor(media).local).toBe(path.join(root, 'Manga'));
  await importChapter(media, { id: 91, chapterNumber: 1, name: 'Chapter 1' });
  await writeMetadata(media);
  await scanLibrary(media);
  const series = path.join(root, 'Manga', 'Legacy Story');
  expect(
    new AdmZip(readFileSync(path.join(series, 'Legacy Story Ch. 0001.cbz'))).getEntry('0001.png'),
  ).not.toBeNull();
  expect(readFileSync(path.join(series, 'ComicInfo.xml'), 'utf8')).toContain('Legacy Story');
  expect(scans).toEqual(['/medias/Manga/Legacy Story']);
  expect(await status()).toMatchObject({ mediaRoot: root });
});
it('never gives the second account access to the legacy root, even with a manual prefix', async () => {
  mkdirSync(path.join(root, 'Manga'));
  await inTenant(2, async () => {
    expect(libraryRoot()).toBe(path.join(root, '2'));
    expect(mapKavitaPath('/library/Manga')).toBeNull();
    expect(mapKavitaPath('/medias/Manga', '/medias')).toBeNull();
    await expect(safeLibraryDirectory(path.join(root, 'Manga'), true)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });
  expect(libraryRoot()).toBe(root);
});
it('uses numeric roots and prefers the exact username when both exist', async () => {
  mkdirSync(path.join(root, '1', 'Manga'), { recursive: true });
  mkdirSync(path.join(root, '2', 'Manga'), { recursive: true });
  expect(libraryRoot()).toBe(path.join(root, '1'));
  expect(inTenant(2, libraryRoot)).toBe(path.join(root, '2'));
  mkdirSync(path.join(root, 'Lucas', 'Manga'), { recursive: true });
  mkdirSync(path.join(root, 'Alice', 'Manga'), { recursive: true });
  expect(libraryRoot()).toBe(path.join(root, 'Lucas'));
  expect(mapKavitaPath('/library/Manga')).toBe(path.join(root, 'Lucas', 'Manga'));
  expect(inTenant(2, () => mapKavitaPath('/library/Manga'))).toBe(
    path.join(root, 'Alice', 'Manga'),
  );
  expect(await status()).toMatchObject({ mediaRoot: path.join(root, 'Lucas') });
});
it('invalidates the legacy decision on settings read as soon as any account root appears', async () => {
  mkdirSync(path.join(root, 'Manga'));
  expect(libraryRoot()).toBe(root);
  expect(await status()).toMatchObject({ mediaRoot: root });
  mkdirSync(path.join(root, 'Alice'));
  getSettings();
  expect(libraryRoot()).toBe(path.join(root, '1'));
  expect(mapKavitaPath('/library/Manga')).toBeNull();
  await expect(safeLibraryDirectory(path.join(root, 'Manga'), true)).rejects.toMatchObject({
    code: 'UNSAFE_PATH',
  });
  expect(await status()).toMatchObject({ mediaRoot: path.join(root, '1') });
  // A temporarily unmounted tenant must never restore broad legacy access, including after cache reset.
  rmSync(path.join(root, 'Alice'), { recursive: true });
  vi.resetModules();
  const restarted = await import('@/lib/media-root');
  expect(restarted.resolveMediaRoot()).toBe(path.join(root, '1'));
  (await import('@/lib/accounts-store')).accountsDb().close();
});
it('rechecks account changes and treats usernames case-sensitively', () => {
  mkdirSync(path.join(root, 'alice'));
  expect(libraryRoot()).toBe(root);
  accountsDb().prepare("UPDATE users SET username='alice' WHERE id=2").run();
  expect(inTenant(2, libraryRoot)).toBe(path.join(root, 'alice'));
  expect(libraryRoot()).toBe(path.join(root, '1'));
});
it('rejects ambiguous numeric usernames, unsafe legacy names, traversal and escaping symlinks', async () => {
  accountsDb().prepare("UPDATE users SET username='../escape' WHERE id=1").run();
  mkdirSync(path.join(root, '1', 'Manga'), { recursive: true });
  expect(libraryRoot()).toBe(path.join(root, '1'));
  expect(mapKavitaPath('/library/../Manga')).toBeNull();
  expect(resolveLibraryFolder('/library/Manga', [], '/../')).toBeNull();
  const outside = mkdtempSync(path.join(directory, 'outside-'));
  symlinkSync(outside, path.join(root, '1', 'escape'));
  expect(mapKavitaPath('/library/escape')).toBeNull();
  await expect(safeLibraryDirectory(path.join(root, '1', 'escape'), true)).rejects.toMatchObject({
    code: 'UNSAFE_PATH',
  });
  accountsDb()
    .prepare(
      `INSERT INTO users(id,username,role,password_hash,session_epoch,created_at)
    VALUES(100,'Hundred','member','fixture','fixture','2026-01-01')`,
    )
    .run();
  accountsDb().prepare("UPDATE users SET username='100' WHERE id=1").run();
  mkdirSync(path.join(root, '100'));
  expect(() => libraryRoot()).toThrow(/Ambiguous/);
  expect(await status()).toMatchObject({ mediaRoot: null });
  accountsDb().prepare('DELETE FROM users WHERE id=100').run();
});
it('refuses username roots that are symlinks instead of falling back to numeric or legacy media', async () => {
  const outside = mkdtempSync(path.join(directory, 'outside-'));
  mkdirSync(path.join(root, '1', 'Manga'), { recursive: true });
  symlinkSync(outside, path.join(root, 'Lucas'));
  expect(() => libraryRoot()).toThrow(/symlink/);
  expect(await status()).toMatchObject({ mediaRoot: null });
  await expect(safeLibraryDirectory(path.join(root, '1', 'Manga'))).rejects.toMatchObject({
    code: 'UNSAFE_PATH',
  });
  rmSync(path.join(root, 'Lucas'));
  symlinkSync(path.join(outside, 'missing'), path.join(root, 'Lucas'));
  expect(() => libraryRoot()).toThrow(/symlink/);
});
it('preserves rejection of ambiguous suffix mappings', () => {
  mkdirSync(path.join(root, 'Lucas', 'medias', 'Manga'), { recursive: true });
  mkdirSync(path.join(root, 'Lucas', 'Manga'), { recursive: true });
  writeFileSync(path.join(root, 'Lucas', 'ignored'), 'fixture');
  expect(mapKavitaPath('/medias/Manga')).toBeNull();
});
