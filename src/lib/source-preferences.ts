import type { SourceHealth, SourcePreferences } from '@/types/shared';
import { db } from './db';
import { getSettings } from './settings';
import { sourcePreferences } from './validation';
export function getSourcePreferences(): SourcePreferences {
  const stored = db().prepare("SELECT value FROM settings WHERE key='sourcePreferences'").get() as
    { value: string } | undefined;
  if (stored) return sourcePreferences.parse(JSON.parse(stored.value));
  // Presence of the new key is the one-time migration marker, even for an empty legacy list.
  return setSourcePreferences({
    enabledSourceIds: getSettings().favoriteSourceIds,
    languages: ['fr'],
  });
}
export function setSourcePreferences(value: SourcePreferences): SourcePreferences {
  const parsed = sourcePreferences.parse(value);
  db()
    .prepare(
      "INSERT INTO settings(key,value) VALUES('sourcePreferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify(parsed));
  return parsed;
}
export function sourceHealth(id: string): SourceHealth {
  const row = db().prepare('SELECT payload FROM source_health WHERE source_id=?').get(id) as
    { payload: string } | undefined;
  return row
    ? JSON.parse(row.payload)
    : { state: 'unknown', latencyMs: null, error: null, detail: null, checkedAt: null };
}
export function recordSourceHealth(
  id: string,
  latencyMs: number,
  error: string | null = null,
  detail: string | null = null,
) {
  const health: SourceHealth = {
    state: error ? 'error' : latencyMs > 4000 ? 'slow' : 'ok',
    latencyMs,
    error,
    detail,
    checkedAt: new Date().toISOString(),
  };
  db()
    .prepare(
      'INSERT INTO source_health(source_id,payload) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload=excluded.payload',
    )
    .run(id, JSON.stringify(health));
}
