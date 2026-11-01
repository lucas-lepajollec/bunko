import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { statement, writeVersion, db } from './db';
import { env } from './env';
import { wakeWorker } from './worker-events';
import { accountsDir, tenantId, tenantState } from './tenant-context';
import { validateLibraryTargets } from './library-paths';
import { chosenMediaRoot, withMediaRootChoice } from './media-root';
import { accountsDb } from './accounts-store';
import { catalogSettingsRows, writeCatalogSettings } from './catalog-settings-store';
import { currentUser } from './user-context';
import { requireAdmin } from './auth';
import { catalogSettingKeys, type CatalogSetting } from '@/types/shared';
import type { PublicSettings, SecretSetting, Settings, SettingsPatch } from '@/types/shared';
export const secretKeys: SecretSetting[] = [
  'suwayomiPassword',
  'kavitaApiKey',
  'sonarrApiKey',
  'prowlarrApiKey',
  'tradocApiKey',
  'googleBooksApiKey',
  'metronApiToken',
  'metronPassword',
  'rakutenApplicationId',
  'rakutenAccessKey',
  'hardcoverToken',
];
export function persistentSecret(name: string, bytes: number): Buffer {
  if (!['access.token', 'settings.key'].includes(name))
    throw new Error('Unknown persistent secret');
  mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const file = path.join(accountsDir, name);
  try {
    writeFileSync(file, randomBytes(bytes).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const value = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  if (value.length !== bytes) throw new Error('Invalid persistent key file');
  return value;
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', persistentSecret('settings.key', 32), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify([
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    body.toString('base64'),
  ]);
}
export function decrypt(value: string) {
  const [iv, tag, body] = JSON.parse(value) as string[];
  const cipher = createDecipheriv(
    'aes-256-gcm',
    persistentSecret('settings.key', 32),
    Buffer.from(iv, 'base64'),
  );
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString(
    'utf8',
  );
}
const settingsState = tenantState(() => ({
  seeded: false,
  snapshot: undefined as { version: number; value: Settings } | undefined,
}));
function serverSettings(): Settings {
  const state = settingsState();
  if (!state.seeded) {
    seedEnvironment();
    if (!db().inTransaction) state.seeded = true;
  }
  const settingsSnapshot = state.snapshot;
  const version = writeVersion('settings');
  if (settingsSnapshot?.version === version) return settingsSnapshot.value;
  const result: Settings = {
    mediaRoot: null,
    suwayomiUrl: '',
    suwayomiUsername: '',
    suwayomiPassword: '',
    kavitaUrl: '',
    kavitaApiKey: '',
    kavitaAuthMode: 'api-key',
    sonarrUrl: '',
    sonarrApiKey: '',
    prowlarrUrl: '',
    prowlarrApiKey: '',
    tradocUrl: '',
    tradocApiKey: '',
    googleBooksApiKey: '',
    metronApiToken: '',
    metronUsername: '',
    metronPassword: '',
    rakutenApplicationId: '',
    rakutenAccessKey: '',
    hardcoverToken: '',
    kavitaLibraryPath: '/library',
    libraryTargets: {},
    autoImportKavita: true,
    adultContent: false,
    hideNsfwSources: true,
    progressSource: 'suwayomi',
    favoriteSourceIds: [],
    extensionRepos: [],
    updateIntervalMinutes: 15,
  };
  for (const row of statement('SELECT key,value FROM settings').all() as {
    key: keyof Settings;
    value: string;
  }[]) {
    if (!(row.key in result) || catalogSettingKeys.includes(row.key as CatalogSetting)) continue;
    Object.assign(result, {
      [row.key]: secretKeys.includes(row.key as SecretSetting)
        ? decrypt(row.value)
        : JSON.parse(row.value),
    });
  }
  result.updateIntervalMinutes = Math.max(5, Math.min(1440, result.updateIntervalMinutes));
  if (!db().inTransaction) state.snapshot = { version, value: result };
  return result;
}
let catalogSnapshot:
  { rows: ReturnType<typeof catalogSettingsRows>; value: Partial<Settings> } | undefined;
export function getSettings(): Settings {
  const privateSettings = serverSettings();
  const rows = catalogSettingsRows(accountsDb());
  if (catalogSnapshot?.rows !== rows) {
    const value: Partial<Settings> = {};
    for (const [key, raw] of Object.entries(rows))
      Object.assign(value, { [key]: key === 'metronUsername' ? JSON.parse(raw) : decrypt(raw) });
    catalogSnapshot = { rows, value };
  }
  return {
    ...structuredClone(privateSettings),
    ...catalogSnapshot.value,
    mediaRoot: chosenMediaRoot(),
  };
}
export function publicSettings(): PublicSettings {
  const settings = getSettings();
  const safe = { ...settings } as Record<string, unknown>;
  const secretsConfigured = {} as Record<SecretSetting, boolean>;
  for (const key of secretKeys) {
    secretsConfigured[key] = Boolean(settings[key]);
    delete safe[key];
  }
  const canManage = currentUser()?.role === 'admin';
  if (!canManage) safe.metronUsername = '';
  return {
    ...safe,
    secretsConfigured,
    catalogs: {
      canManage,
      configured: {
        googlebooks: Boolean(settings.googleBooksApiKey),
        metron: Boolean(
          settings.metronApiToken || (settings.metronUsername && settings.metronPassword),
        ),
        rakuten: Boolean(settings.rakutenApplicationId && settings.rakutenAccessKey),
        hardcover: Boolean(settings.hardcoverToken),
      },
    },
  } as PublicSettings;
}
export function updateSettings(patch: SettingsPatch) {
  const shared = Object.entries(patch).filter(([key]) =>
    catalogSettingKeys.includes(key as CatalogSetting),
  );
  if (shared.length) requireAdmin();
  const current = getSettings();
  const sharedRows = Object.fromEntries(
    shared.map(([key, value]) => [
      key,
      key === 'metronUsername' ? JSON.stringify(value) : encrypt(String(value)),
    ]),
  );
  withMediaRootChoice(patch.mediaRoot, () => {
    if (patch.libraryTargets !== undefined || patch.kavitaLibraryPath !== undefined)
      validateLibraryTargets(
        patch.libraryTargets ?? current.libraryTargets,
        patch.kavitaLibraryPath ?? current.kavitaLibraryPath,
      );
    const insert = statement(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    db().transaction(() => {
      if (patch.kavitaUrl !== undefined && patch.kavitaUrl !== current.kavitaUrl) {
        // Series IDs belong to the previous Kavita server: series 7 there is another work here.
        // Forget them (manual links included) and rebuild the index from the new server.
        db().exec(`UPDATE tracked_media SET kavita_series_id=NULL,kavita_manual=0;
          DELETE FROM kavita_series; DELETE FROM kavita_dismissals; DELETE FROM kavita_cover_status;
          DELETE FROM worker_state WHERE key LIKE 'kavita_cover_hash:%' OR key='kavita_index_revision';`);
        if (patch.kavitaUrl)
          db()
            .prepare(
              "INSERT OR REPLACE INTO worker_state(key,value) VALUES('kavita_sync_requested','1')",
            )
            .run();
      }
      if (patch.suwayomiUrl !== undefined && patch.suwayomiUrl !== current.suwayomiUrl) {
        // Chapter IDs from the previous server could name other chapters: forget source positions.
        db().exec('DELETE FROM reader_progress WHERE chapter_id>0');
        // Numeric manga/source identities from the previous server cannot be reused safely.
        db().exec(`UPDATE tracked_media SET sources_json='[]',source_match_at=NULL,
          media_json=json_set(media_json,'$.sources',json('[]'));
          DELETE FROM source_links; DELETE FROM source_dismissals;
          DELETE FROM catalog_fts; DELETE FROM catalog_keys;
          DELETE FROM source_health; DELETE FROM source_flags;`);
      }
      if (
        (patch.kavitaApiKey !== undefined && patch.kavitaApiKey !== current.kavitaApiKey) ||
        (patch.kavitaUrl !== undefined && patch.kavitaUrl !== current.kavitaUrl)
      ) {
        statement(
          'UPDATE tracked_media SET last_read=NULL,volume_read=NULL,last_read_at=NULL,progress_checked=0',
        ).run();
        statement("DELETE FROM worker_state WHERE key LIKE 'progress_refresh_attempt:%'").run();
        statement("UPDATE kavita_series SET payload=json_remove(payload,'$.volumeRead')").run();
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'mediaRoot' || catalogSettingKeys.includes(key as CatalogSetting)) continue;
        insert.run(
          key,
          secretKeys.includes(key as SecretSetting)
            ? encrypt(String(value))
            : JSON.stringify(value),
        );
      }
      if (shared.length) writeCatalogSettings(accountsDb(), sharedRows);
    })();
  });
  wakeWorker();
  return publicSettings();
}

/** Environment values seed only tenant 1, once, and never overwrite persisted settings. */
function seedEnvironment() {
  const database = db();
  if (database.prepare("SELECT 1 FROM worker_state WHERE key='environment_seeded'").get()) return;
  database
    .transaction(() => {
      if (tenantId() === 1) {
        const keys = {
          suwayomiUrl: 'SUWAYOMI_URL',
          suwayomiUsername: 'SUWAYOMI_USERNAME',
          suwayomiPassword: 'SUWAYOMI_PASSWORD',
          kavitaUrl: 'KAVITA_URL',
          kavitaApiKey: 'KAVITA_API_KEY',
          sonarrUrl: 'SONARR_URL',
          sonarrApiKey: 'SONARR_API_KEY',
          prowlarrUrl: 'PROWLARR_URL',
          prowlarrApiKey: 'PROWLARR_API_KEY',
          tradocUrl: 'TRADOC_URL',
          tradocApiKey: 'TRADOC_API_KEY',
        };
        for (const [key, name] of Object.entries(keys)) {
          const value = process.env[name] ?? env(name);
          if (value !== undefined)
            database
              .prepare('INSERT OR IGNORE INTO settings VALUES(?,?)')
              .run(
                key,
                secretKeys.includes(key as SecretSetting) ? encrypt(value) : JSON.stringify(value),
              );
        }
      }
      database.prepare("INSERT OR IGNORE INTO worker_state VALUES('environment_seeded','1')").run();
    })
    .immediate();
}
