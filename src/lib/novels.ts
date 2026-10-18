import type { DiscoverPage, DiscoverQuery } from '@/types/shared';
import { mangaUpdates } from './mangaupdates';
import { cached, storedMetadata, saveMetadata, discoveryStatus } from './metadata-cache';
import { fromMangaUpdates, updatesNovelFormat, type UpdatesRecord } from './media';
import { dataDir } from './db';
import { tenantSignal } from './tenant-lifecycle';
import { AppError } from './errors';
const runtime = globalThis as typeof globalThis & {
  __bunkoNovelLoads?: Map<string, Promise<void>>;
};
const loads = (runtime.__bunkoNovelLoads ??= new Map<string, Promise<void>>());
export function resolvedNovelRecord(record: UpdatesRecord) {
  return storedMetadata<UpdatesRecord>(`mu:series:${record.series_id}`)?.value ?? record;
}
/** Submit one request at a time, so interactive MU requests can enter between background sheets. */
export function enrichNovelRecords(records: UpdatesRecord[]): boolean {
  const novel = records.filter(
    (r) => /^novel$/i.test(r.type ?? '') && updatesNovelFormat(r) !== 'WEB_NOVEL',
  );
  const prefix = `${dataDir()}:novel:`;
  const unknown = novel.filter((r) => {
    if (loads.has(`${prefix}${r.series_id}`)) return false;
    const sheet = storedMetadata(`mu:series:${r.series_id}`);
    const attempt = storedMetadata(`mu:novel-attempt:${r.series_id}`);
    return (
      (!sheet || Date.now() - sheet.at >= 7 * 86400_000) &&
      (!attempt || Date.now() - attempt.at >= 5 * 60_000)
    );
  });
  if (unknown.length) {
    const signal = AbortSignal.any([tenantSignal(), AbortSignal.timeout(30_000)]);
    const job = Promise.resolve()
      .then(async () => {
        for (const record of unknown) {
          if (signal.aborted) break;
          try {
            saveMetadata(`mu:novel-attempt:${record.series_id}`, { failed: false });
            await cached(
              `mu:series:${record.series_id}`,
              7 * 86400_000,
              () => mangaUpdates<UpdatesRecord>(`/series/${record.series_id}`, { signal }),
              { waitForRefresh: true },
            );
          } catch {
            if (!tenantSignal().aborted)
              saveMetadata(`mu:novel-attempt:${record.series_id}`, { failed: true });
          }
        }
      })
      .catch(() => {
        /* Tenant deletion or shutdown: a future request can resume. */
      })
      .finally(() => {
        for (const record of unknown) loads.delete(`${prefix}${record.series_id}`);
      });
    for (const record of unknown) loads.set(`${prefix}${record.series_id}`, job);
  }
  return novel.some((r) => loads.has(`${prefix}${r.series_id}`));
}

export async function discoverWebNovels(q: DiscoverQuery): Promise<DiscoverPage> {
  const page = q.page ?? 1,
    perPage = q.perPage ?? 24;
  if (q.season) return { items: [], page, hasNextPage: false };
  const body = {
    type: ['Novel'],
    page,
    perpage: perPage,
    orderby: { trending: 'week_pos', popular: 'list_reading', score: 'rating', new: 'year' }[
      q.sort ?? 'trending'
    ],
    ...(q.genre ? { genre: [q.genre] } : {}),
    ...(q.year ? { year: String(q.year) } : {}),
    ...(q.status === 'FINISHED' ? { filter: 'completed' } : {}),
  };
  const cacheKey = `discover:mu-novels:${JSON.stringify(body)}`;
  const data = await cached(cacheKey, 30 * 60_000, () =>
    mangaUpdates<{ results: { record: UpdatesRecord }[]; total_hits: number }>('/series/search', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }),
  );
  const records = data.results.slice(0, perPage).map((r) => r.record);
  const pending = enrichNovelRecords(records);
  const items = [];
  for (const record of records) {
    const media = fromMangaUpdates(resolvedNovelRecord(record));
    if (media.format !== 'WEB_NOVEL') continue;
    if (q.sort === 'new' && (media.year == null || media.year > new Date().getUTCFullYear()))
      continue;
    if (q.status === 'RELEASING' && /complete|finished/i.test(media.status ?? '')) continue;
    items.push(media);
  }
  if (
    !pending &&
    !items.length &&
    records.some(
      (r) => storedMetadata<{ failed: boolean }>(`mu:novel-attempt:${r.series_id}`)?.value.failed,
    )
  )
    throw new AppError(
      'METADATA_UNAVAILABLE',
      'Web novel classification is temporarily unavailable',
      502,
    );
  const state = discoveryStatus(cacheKey, 'mangaupdates');
  return {
    ...state,
    items,
    page,
    hasNextPage: page * perPage < data.total_hits,
    pending: pending || state.pending,
  };
}
