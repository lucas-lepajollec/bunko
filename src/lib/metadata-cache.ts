import { statement, dataDir, db } from './db';

const MAX_ENTRIES = 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const scope = globalThis as typeof globalThis & {
  __bunkoMetadataLoads?: Map<string, Promise<unknown>>;
};
const parsed = new Map<string, { payload: string; value: unknown }>();
let parsedBytes = 0;
const loads = (scope.__bunkoMetadataLoads ??= new Map());
export function storedMetadata<T>(key: string): { value: T; at: number; attempted: number } | null {
  const row = statement(
    'SELECT payload,updated_at,attempted_at FROM metadata_cache WHERE key=?',
  ).get(key) as { payload: string; updated_at: number; attempted_at: number } | undefined;
  if (!row) {
    parsed.delete(key);
    return null;
  }
  let hit = parsed.get(key);
  if (hit?.payload !== row.payload) {
    hit = { payload: row.payload, value: JSON.parse(row.payload) };
    const size = Buffer.byteLength(row.payload);
    if (parsed.size >= 64 || parsedBytes + size > 16 * 1024 * 1024) {
      parsed.clear();
      parsedBytes = 0;
    }
    parsedBytes += size;
    parsed.set(key, hit);
  }
  return {
    value: structuredClone(hit.value) as T,
    at: row.updated_at,
    attempted: row.attempted_at,
  };
}
export function saveMetadata(key: string, value: unknown, updatedAt = Date.now()) {
  const payload = JSON.stringify(value);
  const size = Buffer.byteLength(payload);
  if (size > 8 * 1024 * 1024) return;
  db().transaction(() => {
    statement(
      `INSERT INTO metadata_cache(key,payload,bytes,updated_at,attempted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,
      updated_at=excluded.updated_at,attempted_at=excluded.attempted_at`,
    ).run(key, payload, size, updatedAt, updatedAt);
    const rows = statement(
      'SELECT key,bytes FROM metadata_cache ORDER BY updated_at DESC,key DESC',
    ).all() as { key: string; bytes: number }[];
    let bytes = 0;
    rows.forEach((row, i) => {
      bytes += row.bytes;
      if (i >= MAX_ENTRIES || bytes > MAX_BYTES)
        statement('DELETE FROM metadata_cache WHERE key=?').run(row.key);
    });
  })();
}
/** Stale values return immediately by default; ingestion can await revalidation after publishing them. */
export async function cached<T>(
  key: string,
  ttl: number,
  load: () => Promise<T>,
  options: { waitForRefresh?: boolean } = {},
): Promise<T> {
  const hit = storedMetadata<T>(key);
  const pendingKey = `${dataDir}:${key}`;
  const refresh = () => {
    let pending = loads.get(pendingKey) as Promise<T> | undefined;
    if (!pending) {
      if (hit)
        statement('UPDATE metadata_cache SET attempted_at=? WHERE key=?').run(Date.now(), key);
      pending = Promise.resolve()
        .then(load)
        .then((value) => {
          saveMetadata(key, value);
          return value;
        })
        .finally(() => loads.delete(pendingKey));
      loads.set(pendingKey, pending);
    }
    return pending;
  };
  if (hit) {
    if (Date.now() - hit.at >= ttl && Date.now() - hit.attempted >= Math.min(ttl, 30_000)) {
      if (options.waitForRefresh) return structuredClone(await refresh());
      void refresh().catch(() => {
        /* The persisted value remains available. */
      });
    }
    return hit.value;
  }
  return structuredClone(await refresh());
}
