import { normalizeHome } from './home-shape';
import { tenantState } from './tenant-context';
import { rememberAdultIdentities } from './adult';
import { statement, dataDir, db } from './db';

// Bump when a persisted provider/response contract changes. Older home feeds can be repaired;
// all other unversioned/incompatible entries are cold misses, never served as current responses.
const SCHEMA = 1;
const MAX_ENTRIES = 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const scope = globalThis as typeof globalThis & {
  __bunkoMetadataLoads?: Map<string, Promise<unknown>>;
};
const parsedState = tenantState(() => ({
  parsed: new Map<string, { payload: string; value: unknown }>(),
  parsedBytes: 0,
}));
const loads = (scope.__bunkoMetadataLoads ??= new Map());
/** Report background refreshes instead of presenting a stale snapshot as a final answer. */
export function metadataStatus(key: string) {
  const pending = loads.has(`${dataDir()}:${key}`);
  const hit = storedMetadata<unknown>(key);
  return { pending, partial: !pending && Boolean(hit && hit.attempted > hit.at) };
}
export function discoveryStatus(key: string, provider: string) {
  const state = metadataStatus(key);
  return {
    pending: state.pending,
    ...(state.partial ? { warnings: [{ provider, code: 'METADATA_UNAVAILABLE' as const }] } : {}),
  };
}
export function storedMetadata<T>(key: string): { value: T; at: number; attempted: number } | null {
  const state = parsedState();
  const parsed = state.parsed;
  const row = statement(
    'SELECT payload,updated_at,attempted_at FROM metadata_cache WHERE key=?',
  ).get(key) as { payload: string; updated_at: number; attempted_at: number } | undefined;
  if (!row) {
    parsed.delete(key);
    return null;
  }
  let hit = parsed.get(key);
  if (hit?.payload !== row.payload) {
    const decoded = decodeMetadata(key, row.payload);
    if (!decoded) return null;
    hit = { payload: row.payload, value: decoded.value };
    const size = Buffer.byteLength(row.payload);
    if (parsed.size >= 64 || state.parsedBytes + size > 16 * 1024 * 1024) {
      parsed.clear();
      state.parsedBytes = 0;
    }
    state.parsedBytes += size;
    parsed.set(key, hit);
  }
  return {
    value: structuredClone(hit.value) as T,
    at: row.updated_at,
    attempted: row.attempted_at,
  };
}
/** Shared with bulk catalog scans: SQL readers must observe the same schema boundary. */
export function decodeMetadata(key: string, payload: string): { value: unknown } | null {
  let envelope: { schema?: number; value?: unknown };
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }
  let value: unknown;
  if (envelope?.schema === SCHEMA) value = envelope.value;
  else if (
    key.startsWith('home:') &&
    envelope &&
    typeof envelope === 'object' &&
    'latest' in envelope
  )
    value = normalizeHome(envelope);
  else if (key.startsWith('home:top:') && Array.isArray(envelope)) value = envelope;
  else return null;
  if (key.startsWith('home:') && value && typeof value === 'object' && 'latest' in value)
    value = normalizeHome(value);
  return { value };
}
export function rememberIdentities(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(rememberIdentities);
    return;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id === 'string' && Array.isArray(item.providers))
    rememberAdultIdentities(item as unknown as import('@/types/shared').UnifiedMedia);
  for (const child of Object.values(item))
    if (child && typeof child === 'object') rememberIdentities(child);
}
export function saveMetadata(key: string, value: unknown, updatedAt = Date.now()) {
  const payload = JSON.stringify({ schema: SCHEMA, value });
  const size = Buffer.byteLength(payload);
  if (size > 8 * 1024 * 1024) return;
  db().transaction(() => {
    rememberIdentities(value);
    statement(
      `INSERT INTO metadata_cache(key,payload,bytes,updated_at,attempted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,
      updated_at=excluded.updated_at,attempted_at=excluded.attempted_at`,
    ).run(key, payload, size, updatedAt, updatedAt);
    const usage = statement(
      "SELECT bytes,entries FROM cache_usage WHERE name='metadata_cache'",
    ).get() as { bytes: number; entries: number };
    if (usage.bytes <= MAX_BYTES && usage.entries <= MAX_ENTRIES) return;
    const rows = statement(
      'SELECT key,bytes FROM metadata_cache ORDER BY updated_at DESC,key DESC',
    ).all() as { key: string; bytes: number }[];
    let bytes = 0;
    rows.forEach((row, i) => {
      // Two bounded last-good shelves must survive generic provider-cache churn.
      if (/^home:top:(true|false)$/.test(row.key)) return;
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
  options: {
    waitForRefresh?: boolean;
    accept?: (value: T) => boolean;
    onError?: (error: unknown) => void;
  } = {},
): Promise<T> {
  const stored = storedMetadata<T>(key);
  const hit = stored && (!options.accept || options.accept(stored.value)) ? stored : null;
  const pendingKey = `${dataDir()}:${key}`;
  const refresh = () => {
    let pending = loads.get(pendingKey) as Promise<T> | undefined;
    if (!pending) {
      if (hit)
        statement('UPDATE metadata_cache SET attempted_at=? WHERE key=?').run(Date.now(), key);
      pending = Promise.resolve()
        .then(load)
        .then((value) => {
          if (!options.accept || options.accept(value)) saveMetadata(key, value);
          return options.accept && !options.accept(value) && hit ? hit.value : value;
        })
        .catch((error) => {
          options.onError?.(error);
          throw error;
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
