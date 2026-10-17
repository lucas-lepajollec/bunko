import type { DiscoverPage, DiscoverQuery } from '@/types/shared';
import { mangaUpdates } from './mangaupdates';
import { cached } from './metadata-cache';
import { fromMangaUpdates, type UpdatesRecord } from './media';

/** Search summaries omit publication/category evidence; use the full, durably cached sheet. */
export async function novelRecord(record: UpdatesRecord): Promise<UpdatesRecord> {
  if (!/^novel$/i.test(record.type ?? '')) return record;
  try {
    return await cached(`mu:series:${record.series_id}`, 7 * 86400_000, () =>
      mangaUpdates<UpdatesRecord>(`/series/${record.series_id}`),
    );
  } catch {
    // No positive web-serialization evidence: the documented fallback is a published LN.
    return record;
  }
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
  const data = await cached(`discover:mu-novels:${JSON.stringify(body)}`, 30 * 60_000, () =>
    mangaUpdates<{ results: { record: UpdatesRecord }[]; total_hits: number }>('/series/search', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  const items = [];
  for (const { record } of data.results.slice(0, perPage)) {
    const media = fromMangaUpdates(await novelRecord(record));
    if (media.format !== 'WEB_NOVEL') continue;
    if (q.sort === 'new' && (media.year == null || media.year > new Date().getUTCFullYear()))
      continue;
    if (q.status === 'RELEASING' && /complete|finished/i.test(media.status ?? '')) continue;
    items.push(media);
  }
  return { items, page, hasNextPage: page * perPage < data.total_hits };
}
