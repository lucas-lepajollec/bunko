import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { statement, writeVersion, db } from './db';
import { env } from './env';
import { wakeWorker } from './worker-events';
import { accountsDir, tenantId, tenantState } from './tenant-context';
import { validateLibraryTargets } from './library-paths';
import { mediaRootStatus } from './media-root';
import type { PublicSettings, SecretSetting, Settings, SettingsPatch } from '@/types/shared';
export const secretKeys: SecretSetting[] = [
  'suwayomiPassword',
  'kavitaApiKey',
  'sonarrApiKey',
  'prowlarrApiKey',
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
    kavitaLibraryPath: '/library',
    libraryTargets: {},
    autoImportKavita: true,
    adultContent: false,
    favoriteSourceIds: [],
    extensionRepos: [],
    updateIntervalMinutes: 15,
  };
  for (const row of statement('SELECT key,value FROM settings').all() as {
    key: keyof Settings;
    value: string;
  }[]) {
    if (!(row.key in result)) continue;
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
export function getSettings(): Settings {
  mediaRootStatus();
  return structuredClone(serverSettings());
}
export function publicSettings(): PublicSettings {
  const settings = getSettings();
  const { suwayomiPassword, kavitaApiKey, sonarrApiKey, prowlarrApiKey, ...safe } = settings;
  return {
    ...safe,
    secretsConfigured: {
      suwayomiPassword: Boolean(suwayomiPassword),
      kavitaApiKey: Boolean(kavitaApiKey),
      sonarrApiKey: Boolean(sonarrApiKey),
      prowlarrApiKey: Boolean(prowlarrApiKey),
    },
  };
}
export function updateSettings(patch: SettingsPatch) {
  const current = getSettings();
  if (patch.libraryTargets !== undefined || patch.kavitaLibraryPath !== undefined)
    validateLibraryTargets(
      patch.libraryTargets ?? current.libraryTargets,
      patch.kavitaLibraryPath ?? current.kavitaLibraryPath,
    );
  const insert = statement(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  db().transaction(() => {
    if (patch.kavitaApiKey !== undefined && patch.kavitaApiKey !== current.kavitaApiKey) {
      statement(
        'UPDATE tracked_media SET last_read=NULL,last_read_at=NULL,progress_checked=0',
      ).run();
      statement("DELETE FROM worker_state WHERE key LIKE 'progress_refresh_attempt:%'").run();
    }
    for (const [key, value] of Object.entries(patch))
      insert.run(
        key,
        secretKeys.includes(key as SecretSetting) ? encrypt(String(value)) : JSON.stringify(value),
      );
  })();
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
