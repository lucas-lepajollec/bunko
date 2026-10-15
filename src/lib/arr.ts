import type { GrabReleaseRequest, Release, ReleaseQuery } from '@/types/shared';
import { AppError } from './errors';
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
export function releaseTags(title: string) {
  const languages = ['VOSTFR', 'MULTI', 'VF', 'FRENCH'].filter((tag) =>
    new RegExp(`(?:^|[ ._\\-\\[\\]])${tag}(?:$|[ ._\\-\\[\\]])`, 'i').test(title),
  );
  const resolution = title.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1].toUpperCase() ?? null;
  const codec = /\b(x265|h[ .]?265|hevc)\b/i.test(title)
    ? 'HEVC'
    : /\b(x264|h[ .]?264|avc)\b/i.test(title)
      ? 'AVC'
      : /\bav1\b/i.test(title)
        ? 'AV1'
        : null;
  return { languages, resolution, codec };
}
interface RawRelease {
  guid: string;
  indexerId: number;
  title: string;
  indexer?: string;
  size: number;
  seeders?: number;
  protocol: string | number;
  rejected?: boolean;
  rejections?: string[];
  publishDate?: string;
}
function config(provider: 'sonarr' | 'prowlarr') {
  const s = getSettings();
  const url = provider === 'sonarr' ? s.sonarrUrl : s.prowlarrUrl;
  const key = provider === 'sonarr' ? s.sonarrApiKey : s.prowlarrApiKey;
  if (!url || !key)
    throw new AppError('SERVICE_NOT_CONFIGURED', `${provider} is not configured`, 409);
  return { url, headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' } };
}
export async function releases(query: ReleaseQuery, signal?: AbortSignal): Promise<Release[]> {
  const provider = query.provider ?? (query.seriesId !== undefined ? 'sonarr' : 'prowlarr');
  const c = config(provider);
  const url = new URL(
    endpoint(c.url, provider === 'sonarr' ? '/api/v3/release' : '/api/v1/search'),
  );
  if (provider === 'sonarr') {
    if (query.seriesId === undefined)
      throw new AppError('VALIDATION_ERROR', 'seriesId is required for Sonarr');
    url.searchParams.set('seriesId', String(query.seriesId));
    for (const k of ['seasonNumber', 'episodeNumber'] as const)
      if (query[k] !== undefined) url.searchParams.set(k, String(query[k]));
  } else {
    if (!query.query) throw new AppError('VALIDATION_ERROR', 'query is required for Prowlarr');
    url.searchParams.set('query', query.query);
    url.searchParams.set('type', 'search');
  }
  const rows = await requestJson<RawRelease[]>(url, { headers: c.headers, signal }, 30_000);
  return rows.map((r) => ({
    provider,
    guid: r.guid,
    indexerId: r.indexerId,
    title: r.title,
    indexer: r.indexer ?? '',
    sizeBytes: r.size,
    sizeGb: Math.round((r.size / 1024 ** 3) * 100) / 100,
    seeders: r.seeders ?? null,
    ...releaseTags(r.title),
    protocol: String(r.protocol),
    rejected: r.rejected ?? false,
    rejections: r.rejections ?? [],
    publishDate: r.publishDate ?? null,
  }));
}
export async function grabRelease(input: GrabReleaseRequest) {
  const c = config(input.provider);
  const path = input.provider === 'sonarr' ? '/api/v3/release' : '/api/v1/search';
  const body = { guid: input.guid, indexerId: input.indexerId };
  const response = await fetch(endpoint(c.url, path), {
    method: 'POST',
    headers: c.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new AppError('ARR_GRAB_ERROR', `Release grab returned HTTP ${response.status}`, 502);
}
