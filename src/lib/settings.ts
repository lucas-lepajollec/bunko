import { currentUser } from './user-context';
import { userAdultContent, patchMyAccount } from './users';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { statement, writeVersion, db, dataDir } from './db';
import { validateLibraryTargets } from './library-paths';
import type { PublicSettings, SecretSetting, Settings, SettingsPatch } from '@/types/shared';
export const secretKeys: SecretSetting[] = [
  'suwayomiPassword',
  'kavitaApiKey',
  'sonarrApiKey',
  'prowlarrApiKey',
];
export function persistentSecret(name: string, bytes: number): Buffer {
  db();
  const file = path.join(dataDir, name);
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
let settingsSnapshot: { version: number; value: Settings } | undefined;
function serverSettings(): Settings {
  const version = writeVersion('settings');
  if (settingsSnapshot?.version === version) return settingsSnapshot.value;
  const result: Settings = {
    suwayomiUrl: process.env.SUWAYOMI_URL ?? 'http://suwayomi:4567',
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
  if (!db().inTransaction) settingsSnapshot = { version, value: result };
  return result;
}
export function getSettings(): Settings {
  const settings = serverSettings();
  return currentUser()?.id ? { ...settings, adultContent: userAdultContent() } : settings;
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
  const preference = currentUser()?.id ? patch.adultContent : undefined;
  if (preference !== undefined) {
    patch = { ...patch };
    delete patch.adultContent;
  }
  if (patch.libraryTargets !== undefined || patch.kavitaLibraryPath !== undefined)
    validateLibraryTargets(
      patch.libraryTargets ?? current.libraryTargets,
      patch.kavitaLibraryPath ?? current.kavitaLibraryPath,
    );
  const insert = statement(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  db().transaction(() => {
    if (preference !== undefined) patchMyAccount({ adultContent: preference });
    if (patch.kavitaApiKey !== undefined && patch.kavitaApiKey !== current.kavitaApiKey) {
      statement(
        'UPDATE user_library SET last_read=NULL,last_read_at=NULL,progress_checked=0 WHERE user_id=1 AND EXISTS(SELECT 1 FROM users WHERE id=1 AND kavita_key IS NULL)',
      ).run();
      statement('DELETE FROM worker_state WHERE key=?').run('progress_refresh_attempt:1');
    }
    for (const [key, value] of Object.entries(patch))
      insert.run(
        key,
        secretKeys.includes(key as SecretSetting) ? encrypt(String(value)) : JSON.stringify(value),
      );
  })();
  return publicSettings();
}
