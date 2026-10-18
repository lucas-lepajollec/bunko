import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const { renameSync } = await import('node:fs');
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-migration-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'template');
process.env.BUNKO_WORKER = 'false';
const template = await import('@/lib/db');
const context = await import('@/lib/tenant-context');
const settings = await import('@/lib/settings');
const mediaModule = await import('@/lib/media');
const token = settings.persistentSecret('access.token', 32).toString('hex');
context.inTenant(1, () =>
  settings.updateSettings({
    suwayomiUrl: 'http://old-suwayomi.test',
    kavitaUrl: 'http://old-kavita.test',
    kavitaApiKey: 'encrypted-fixture-key',
    adultContent: true,
  }),
);
const templateFile = path.join(directory, 'template.db');
await context.inTenant(1, () => template.db().backup(templateFile));
template.closeTenant(1);
const handles: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUWAYOMI_URL;
  for (const d of handles.splice(0)) if (d.open) d.close();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(name: string, v9: boolean, legacyName = false) {
  const volume = path.join(directory, name);
  mkdirSync(volume, { recursive: true });
  const filename = path.join(volume, legacyName ? 'kaviseerr.db' : 'bunko.db');
  cpSync(templateFile, filename);
  cpSync(path.join(directory, 'template', 'settings.key'), path.join(volume, 'settings.key'));
  writeFileSync(path.join(volume, 'access.token'), token, { mode: 0o600 });
  const old = new Database(filename);
  old.pragma('foreign_keys=ON');
  old.exec(`CREATE TABLE administrator(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL,session_epoch TEXT NOT NULL);
    INSERT INTO administrator VALUES(1,'LegacyAdmin','legacy-password-hash','retained-session-epoch');
    PRAGMA user_version=8;`);
  const insert = old.prepare(
    'INSERT INTO tracked_media(id,title,type,created_at,media_json,sources_json,status,last_read,last_read_at,progress_checked,released) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  old.transaction(() => {
    for (let id = 1; id <= 1200; id++) {
      const media = {
        ...mediaModule.emptyMedia(`anilist:${id}`, `Legacy ${id}`, 'MANGA'),
        anilistId: id,
      };
      insert.run(
        id,
        media.title,
        'MANGA',
        `2025-01-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`,
        JSON.stringify(media),
        '[]',
        ['PLANNING', 'READING', 'PAUSED', 'COMPLETED', 'DROPPED'][id % 5],
        id % 100,
        '2026-09-10T12:00:00Z',
        1,
        110,
      );
      old
        .prepare(
          'INSERT INTO imported_chapters(chapter_id,tracked_id,media_json,number,imported_at) VALUES(?,?,?,?,?)',
        )
        .run(id, id, JSON.stringify(media), id, '2026-01-01');
      old
        .prepare('INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name) VALUES(?,?,?,?,?)')
        .run(id, id, id + 1, '123', 'Fixture');
    }
    old
      .prepare('INSERT INTO source_links VALUES(?,?,?,?)')
      .run(
        1,
        '123',
        5,
        JSON.stringify({ sourceId: '123', suwayomiMangaId: 5, title: 'Legacy source' }),
      );
    old.prepare('INSERT INTO download_batches VALUES(?,?)').run(
      'legacy-batch',
      JSON.stringify({
        id: 'legacy-batch',
        state: 'completed',
        media: mediaModule.emptyMedia('anilist:1', 'Legacy 1', 'MANGA'),
        chapterIds: [1],
        importedIds: [1],
      }),
    );
    old
      .prepare('INSERT INTO download_jobs VALUES(?,?)')
      .run(2, JSON.stringify({ chapterId: 2, state: 'queued' }));
  })();
  if (v9) {
    template.migrateV9(old);
    old.exec(`INSERT INTO users(username,role,password_hash,session_epoch,created_at) VALUES('OldMember','member','member-hash','member-epoch','2026-01-01');
      INSERT INTO user_library(user_id,tracked_id,status,last_read,created_at) VALUES(2,1,'DROPPED',99,'2026-10-01');
      UPDATE user_library SET status='PAUSED',last_read=42 WHERE user_id=1 AND tracked_id=1;`);
  }
  const tables = [
    'settings',
    'tracked_media',
    'imported_chapters',
    'observed_chapters',
    'source_links',
    'download_batches',
    'download_jobs',
  ];
  const preserved = new Map(
    tables.map((t) => [t, JSON.stringify(old.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]),
  );
  if (v9) {
    const expected = JSON.parse(preserved.get('tracked_media')!);
    expected[0].status = 'PAUSED';
    expected[0].last_read = 42;
    preserved.set('tracked_media', JSON.stringify(expected));
  }
  old.pragma('wal_checkpoint(TRUNCATE)');
  old.close();
  for (const [relative, bytes] of [
    ['covers/1-fixture.png', Buffer.from([0, 1, 255, 9])],
    ['cache/images/fixture', Buffer.from('packed-private-cache')],
    ['page-cache/7/0.page', Buffer.from('page-bytes')],
  ]) {
    const file = path.join(volume, String(relative));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return { volume, preserved };
}
async function boot(volume: string) {
  vi.resetModules();
  process.env.BUNKO_DATA_DIR = volume;
  const store = await import('@/lib/accounts-store');
  const accounts = store.accountsDb();
  handles.push(accounts);
  const tenant = await import('@/lib/tenant-context');
  const lib = await import('@/lib/db');
  const first = tenant.inTenant(1, lib.db);
  handles.push(first);
  return {
    store,
    tenant,
    lib,
    first,
    accounts,
    settings: await import('@/lib/settings'),
    auth: await import('@/lib/auth'),
  };
}
for (const v9 of [false, true])
  it(`migrates a realistic copied ${v9 ? 'v9' : 'pre-v9'} installation, preserving rows, bytes and sessions through restart`, async () => {
    const f = await fixture(v9 ? 'v9' : 'pre-v9', v9, !v9);
    process.env.SUWAYOMI_URL = 'http://new-env-must-not-overwrite.test';
    const state = await boot(f.volume);
    expect(
      state.accounts
        .prepare('SELECT id,username,role,password_hash,session_epoch FROM users ORDER BY id')
        .all(),
    ).toEqual([
      {
        id: 1,
        username: 'LegacyAdmin',
        role: 'admin',
        password_hash: 'legacy-password-hash',
        session_epoch: 'retained-session-epoch',
      },
      ...(v9
        ? [
            {
              id: 2,
              username: 'OldMember',
              role: 'member',
              password_hash: 'member-hash',
              session_epoch: 'member-epoch',
            },
          ]
        : []),
    ]);
    for (const [table, before] of f.preserved)
      expect(
        JSON.stringify(state.first.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
        table,
      ).toBe(before);
    expect(state.tenant.inTenant(1, () => state.settings.getSettings().kavitaApiKey)).toBe(
      'encrypted-fixture-key',
    );
    expect(state.tenant.inTenant(1, () => state.lib.listTracked())).toHaveLength(1200);
    expect(state.first.pragma('user_version', { simple: true })).toBe(13);
    expect(
      state.first
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('users','user_library','administrator')",
        )
        .all(),
    ).toEqual([]);
    for (const relative of [
      'covers/1-fixture.png',
      'cache/images/fixture',
      'page-cache/7/0.page',
    ]) {
      expect(existsSync(path.join(f.volume, relative))).toBe(false);
      expect(readFileSync(path.join(f.volume, 'users', '1', relative))).toEqual(
        relative.startsWith('covers')
          ? Buffer.from([0, 1, 255, 9])
          : Buffer.from(relative.startsWith('cache') ? 'packed-private-cache' : 'page-bytes'),
      );
    }
    const cookieValue = `v2.1.${Date.now() + 86400_000}.retained-session-epoch`;
    const signature = createHmac('sha256', token).update(cookieValue).digest('hex');
    expect(
      state.auth.authenticate(
        new Request('http://fixture.test', {
          headers: { Cookie: `bunko_session=${cookieValue}.${signature}` },
        }),
      ).id,
    ).toBe(1);
    if (v9) {
      const second = state.tenant.inTenant(2, state.lib.db);
      handles.push(second);
      expect(state.tenant.inTenant(2, () => state.lib.listTracked())).toEqual([]);
      expect(state.tenant.inTenant(2, () => state.settings.getSettings().suwayomiUrl)).toBe('');
    }
    for (const d of handles.splice(0)) if (d.open) d.close();
    const again = await boot(f.volume);
    for (const [table, before] of f.preserved)
      expect(
        JSON.stringify(again.first.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
        table,
      ).toBe(before);
  });
it('resumes filesystem relocation after an injected crash, without losing accounts or overwriting bytes', async () => {
  const f = await fixture('interrupted', true);
  const original = vi.mocked(renameSync).getMockImplementation()!;
  let moved = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (++moved === 3) throw Error('simulated process interruption');
    return original(from, to);
  });
  vi.resetModules();
  process.env.BUNKO_DATA_DIR = f.volume;
  const store = await import('@/lib/accounts-store');
  expect(() => store.accountsDb()).toThrow('interruption');
  expect(existsSync(path.join(f.volume, 'users', '1', 'bunko.db'))).toBe(true);
  vi.mocked(renameSync).mockImplementation(original);
  const state = await boot(f.volume);
  expect(state.accounts.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 2 });
  for (const [table, before] of f.preserved)
    expect(
      JSON.stringify(state.first.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      table,
    ).toBe(before);
  expect(readFileSync(path.join(f.volume, 'users', '1', 'covers', '1-fixture.png'))).toEqual(
    Buffer.from([0, 1, 255, 9]),
  );
});
it('seeds environment only once for the first instance and preserves legacy variable aliases', async () => {
  const volume = path.join(directory, 'fresh-env');
  mkdirSync(volume);
  delete process.env.BUNKO_DATA_DIR;
  process.env.KAVISEERR_DATA_DIR = volume;
  process.env.SUWAYOMI_URL = 'http://initial-default.test';
  vi.resetModules();
  const lib = await import('@/lib/db');
  const tenant = await import('@/lib/tenant-context');
  const settings = await import('@/lib/settings');
  expect(tenant.inTenant(1, settings.getSettings).suwayomiUrl).toBe('http://initial-default.test');
  process.env.SUWAYOMI_URL = 'http://changed-env.test';
  expect(tenant.inTenant(1, settings.getSettings).suwayomiUrl).toBe('http://initial-default.test');
  expect(tenant.inTenant(2, settings.getSettings).suwayomiUrl).toBe('');
  handles.push(tenant.inTenant(1, lib.db), tenant.inTenant(2, lib.db));
  const { accountsDb } = await import('@/lib/accounts-store');
  handles.push(accountsDb());
  delete process.env.KAVISEERR_DATA_DIR;
});
