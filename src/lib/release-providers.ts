import type { ChapterRelease, UnifiedMedia } from '@/types/shared';
import {
  fromMangaUpdates,
  fromMangaDex,
  isUnwantedUpdatesType,
  type UpdatesRecord,
  type DexManga,
} from './media';
import { cached, storedMetadata } from './metadata-cache';
import { mangaUpdates, BUNKO_USER_AGENT } from './mangaupdates';
import { requestJson } from './http';
import { getSourcePreferences } from './source-preferences';

/** MangaUpdates OpenAPI 1.0.0: ReleaseSearchResponseV1 / ReleaseModelSearchV1. */
export interface UpdatesReleaseResult {
  record: {
    id: number;
    title: string;
    chapter: string | null;
    volume: string | null;
    groups: { name: string }[];
    release_date: string;
    time_added?: { timestamp: number; as_rfc3339: string };
  };
  metadata?: { series?: { series_id: number | null } | null };
}
export function releaseNumber(value: string | null | undefined): number | null {
  return value != null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
}
export function releaseLabel(chapter: string | null, volume: string | null) {
  return (
    [volume ? `v.${volume}` : '', chapter ? `c.${chapter}` : ''].filter(Boolean).join(' ') ||
    'Special'
  );
}
export function updatesRelease(
  row: UpdatesReleaseResult,
  media: UnifiedMedia,
): ChapterRelease | null {
  const r = row.record;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.release_date) || !Number.isFinite(Date.parse(r.release_date)))
    return null;
  // The feed follows when a chapter appeared on MU. Old imports retain their stated day.
  const added = r.time_added?.as_rfc3339;
  const localDay = added?.slice(0, 10);
  const hasTime = Boolean(
    added &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(added) &&
    Number.isFinite(Date.parse(added)) &&
    Math.abs(Date.parse(localDay!) - Date.parse(r.release_date)) <= 86400_000,
  );
  return {
    id: `mangaupdates:${r.id}`,
    media,
    chapter: releaseNumber(r.chapter),
    volume: releaseNumber(r.volume),
    label: releaseLabel(r.chapter, r.volume),
    group: r.groups?.map((g) => g.name).join(', ') || null,
    releasedAt: hasTime ? new Date(added!).toISOString() : r.release_date,
    hasTime,
    provider: 'mangaupdates',
    unit: !r.chapter && r.volume ? 'volume' : 'chapter',
    trackedId: null,
  };
}
export async function fetchUpdatesReleases(
  page: number,
  onBatch: (items: ChapterRelease[]) => void = () => {},
  lookupBudget = 40,
): Promise<ChapterRelease[]> {
  const data = await mangaUpdates<{ results: UpdatesReleaseResult[] }>(
    `/releases/days?include_metadata=true&page=${page}`,
  );
  const results: ChapterRelease[] = [];
  const series = new Map<number, UpdatesReleaseResult[]>();
  for (const row of data.results.slice(0, 1000)) {
    const id = row.metadata?.series?.series_id;
    if (!id) continue; // Null metadata exists in the public daily listing.
    const rows = series.get(id) ?? [];
    rows.push(row);
    series.set(id, rows);
  }
  const emit = (record: UpdatesRecord, rows: UpdatesReleaseResult[]) => {
    if (isUnwantedUpdatesType(record.type)) return;
    const media = fromMangaUpdates(record);
    const batch = rows.flatMap((row) => {
      const release = updatesRelease(row, media);
      return release ? [release] : [];
    });
    results.push(...batch);
    return batch;
  };
  const missing: [number, UpdatesReleaseResult[]][] = [];
  const stale: [number, UpdatesReleaseResult[]][] = [];
  const cachedBatch: ChapterRelease[] = [];
  const failures: unknown[] = [];
  // Scan the whole page before waiting on any sheets, including cached series past the budget.
  for (const [id, rows] of series) {
    const key = `mu:series:${id}`;
    const hit = storedMetadata<UpdatesRecord>(key);
    if (!hit) missing.push([id, rows]);
    else {
      try {
        cachedBatch.push(...(emit(hit.value, rows) ?? []));
      } catch (error) {
        failures.push(error);
      }
      if (Date.now() - hit.at >= 7 * 86400_000) stale.push([id, rows]);
    }
  }
  if (cachedBatch.length) onBatch(cachedBatch);
  // Spend the budget on new series first; each completed sheet is durable immediately.
  for (const [id, rows] of [...missing, ...stale].slice(0, lookupBudget)) {
    try {
      const record = await cached(
        `mu:series:${id}`,
        7 * 86400_000,
        () => mangaUpdates<UpdatesRecord>(`/series/${id}`),
        { waitForRefresh: true },
      );
      const batch = emit(record, rows);
      if (batch?.length) onBatch(batch);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'MangaUpdates series refresh failed');
  return [...new Map(results.map((r) => [r.id, r])).values()];
}
/** MangaDex OpenAPI 5.13.1: Chapter / ChapterAttributes and included relationships. */
export interface DexChapter {
  id: string;
  attributes: {
    chapter: string | null;
    volume: string | null;
    readableAt: string;
    isUnavailable?: boolean;
  };
  relationships: { id: string; type: string; attributes?: { name?: string } }[];
}
export function dexRelease(chapter: DexChapter, media: UnifiedMedia): ChapterRelease | null {
  if (
    chapter.attributes.isUnavailable ||
    !Number.isFinite(Date.parse(chapter.attributes.readableAt))
  )
    return null;
  return {
    id: `mangadex:${chapter.id}`,
    media,
    chapter: releaseNumber(chapter.attributes.chapter),
    volume: releaseNumber(chapter.attributes.volume),
    label: releaseLabel(chapter.attributes.chapter, chapter.attributes.volume),
    group:
      chapter.relationships
        .filter((r) => r.type === 'scanlation_group')
        .map((r) => r.attributes?.name)
        .filter(Boolean)
        .join(', ') || null,
    releasedAt: new Date(chapter.attributes.readableAt).toISOString(),
    hasTime: true,
    provider: 'mangadex',
    unit: !chapter.attributes.chapter && chapter.attributes.volume ? 'volume' : 'chapter',
    trackedId: null,
  };
}
export async function fetchDexReleases(): Promise<ChapterRelease[]> {
  const url = new URL('https://api.mangadex.org/chapter');
  url.searchParams.set('limit', '100');
  url.searchParams.set('order[readableAt]', 'desc');
  url.searchParams.set('includes[]', 'manga');
  url.searchParams.append('includes[]', 'scanlation_group');
  url.searchParams.set('includeFutureUpdates', '0');
  for (const language of getSourcePreferences().languages)
    url.searchParams.append('translatedLanguage[]', language);
  for (const rating of ['safe', 'suggestive', 'erotica', 'pornographic'])
    url.searchParams.append('contentRating[]', rating);
  const { data } = await requestJson<{ data: DexChapter[] }>(url, {
    headers: { 'User-Agent': BUNKO_USER_AGENT },
  });
  const ids = [
    ...new Set(
      data.flatMap((c) => c.relationships.filter((r) => r.type === 'manga').map((r) => r.id)),
    ),
  ].slice(0, 100);
  if (!ids.length) return [];
  const mangaUrl = new URL('https://api.mangadex.org/manga');
  mangaUrl.searchParams.set('limit', '100');
  for (const id of ids) mangaUrl.searchParams.append('ids[]', id);
  mangaUrl.searchParams.append('includes[]', 'cover_art');
  for (const rating of ['safe', 'suggestive', 'erotica', 'pornographic'])
    mangaUrl.searchParams.append('contentRating[]', rating);
  const mangas = await cached(`release:dex:${ids.slice().sort().join(',')}`, 24 * 3600_000, () =>
    requestJson<{ data: DexManga[] }>(mangaUrl, { headers: { 'User-Agent': BUNKO_USER_AGENT } }),
  );
  const media = new Map(mangas.data.map((m) => [m.id, fromMangaDex(m)]));
  return data.flatMap((c) => {
    const id = c.relationships.find((r) => r.type === 'manga')?.id;
    const m = id ? media.get(id) : undefined;
    const release = m ? dexRelease(c, m) : null;
    return release ? [release] : [];
  });
}
