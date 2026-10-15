import type { MediaType, Provider, SearchResponse, UnifiedMedia } from '@/types/shared';
import { listTracked, searchCatalog } from './db';
import { requestJson } from './http';
import {
  aniFields,
  DEX_DOUJINSHI,
  emptyMedia,
  fromAniList,
  fromMangaDex,
  fromMangaUpdates,
  isUnwantedUpdatesType,
  normalizeTitle,
  relevance,
  type AniMedia,
  type DexManga,
  type UpdatesRecord,
} from './media';
export { emptyMedia, normalizeTitle };
function identities(m: UnifiedMedia) {
  return [m.title, ...m.altTitles].map(normalizeTitle).filter(Boolean);
}
export function deduplicate(input: UnifiedMedia[]): UnifiedMedia[] {
  const output: UnifiedMedia[] = [];
  for (const media of input) {
    const keys = identities(media);
    const target = output.find(
      (m) =>
        m.type === media.type &&
        ((m.anilistId !== null && m.anilistId === media.anilistId) ||
          (!(m.anilistId && media.anilistId && m.anilistId !== media.anilistId) &&
            !(m.mangadexId && media.mangadexId && m.mangadexId !== media.mangadexId) &&
            identities(m).some((k) => keys.includes(k)))),
    );
    if (!target) {
      output.push(structuredClone(media));
      continue;
    }
    target.altTitles = [...new Set([...target.altTitles, media.title, ...media.altTitles])].filter(
      (t) => t !== target.title,
    );
    target.providers = [...new Set([...target.providers, ...media.providers])];
    for (const source of media.sources)
      if (
        !target.sources.some(
          (s) => s.sourceId === source.sourceId && s.suwayomiMangaId === source.suwayomiMangaId,
        )
      )
        target.sources.push(source);
    for (const key of [
      'anilistId',
      'mangadexId',
      'mangaUpdatesId',
      'coverUrl',
      'bannerUrl',
      'synopsis',
      'status',
      'score',
      'chapters',
      'episodes',
      'webUrl',
      'format',
      'origin',
      'year',
      'volumes',
      'color',
      'popularity',
    ] as const)
      if (target[key] === null && media[key] !== null) Object.assign(target, { [key]: media[key] });
    target.genres = [...new Set([...target.genres, ...media.genres])];
    if ((media.startDate?.length ?? 0) > (target.startDate?.length ?? 0))
      target.startDate = media.startDate;
    target.authors = [...new Set([...target.authors, ...media.authors])];
  }
  return output;
}
async function anilist(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
): Promise<UnifiedMedia[]> {
  const body = {
    query: `query($search: String!, $type: MediaType!) { Page(perPage: 30) { media(search: $search, type: $type, isAdult: false) { ${aniFields} staff(perPage: 10) { edges { role node { name { full } } } } } } }`,
    variables: { search: query, type: type === 'ANIME' ? 'ANIME' : 'MANGA' },
  };
  const result = await requestJson<{ data?: { Page: { media: AniMedia[] } }; errors?: unknown[] }>(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
    2500,
  );
  if (!result.data || result.errors?.length) throw new Error('AniList rejected query');
  return result.data.Page.media
    .filter((m) => type !== 'NOVEL' || m.format === 'NOVEL')
    .filter((m) => type !== 'MANGA' || m.format !== 'NOVEL')
    .map(fromAniList);
}
async function mangadex(query: string, signal?: AbortSignal): Promise<UnifiedMedia[]> {
  const url = new URL('https://api.mangadex.org/manga');
  url.searchParams.set('title', query);
  url.searchParams.set('limit', '30');
  url.searchParams.set('order[relevance]', 'desc');
  ['cover_art', 'author'].forEach((v) => url.searchParams.append('includes[]', v));
  ['safe', 'suggestive'].forEach((v) => url.searchParams.append('contentRating[]', v));
  url.searchParams.append('excludedTags[]', DEX_DOUJINSHI);
  const r = await requestJson<{ data: DexManga[] }>(url, { signal }, 2500);
  return r.data.map(fromMangaDex);
}
async function mangaupdates(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
): Promise<UnifiedMedia[]> {
  const r = await requestJson<{ results: { record: UpdatesRecord }[] }>(
    'https://api.mangaupdates.com/v1/series/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: query, perpage: 30 }),
      signal,
    },
    2500,
  );
  return r.results
    .map(({ record }) => record)
    .filter((m) => !isUnwantedUpdatesType(m.type))
    .filter((m) => type !== 'NOVEL' || /novel/i.test(m.type ?? ''))
    .filter((m) => type !== 'MANGA' || !/novel/i.test(m.type ?? ''))
    .map(fromMangaUpdates);
}
const cache = new Map<string, { at: number; value: SearchResponse }>();
export async function search(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const start = Date.now();
  const key = `${type}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return structuredClone(hit.value);
  const jobs: { provider: Provider; run: () => Promise<UnifiedMedia[]> }[] = [
    { provider: 'anilist', run: () => anilist(query, type, signal) },
  ];
  if (!type || type === 'MANGA')
    jobs.push({ provider: 'mangadex', run: () => mangadex(query, signal) });
  if (type !== 'ANIME')
    jobs.push({ provider: 'mangaupdates', run: () => mangaupdates(query, type, signal) });
  if (!type || type === 'MANGA')
    jobs.push({
      provider: 'local',
      run: async () =>
        searchCatalog(query).map((r) => ({
          ...emptyMedia(`suwayomi:${r.suwayomiMangaId}`, r.title, 'MANGA'),
          sources: [r],
          providers: ['local'],
        })),
    });
  const timings: number[] = [];
  const settled = await Promise.allSettled(
    jobs.map(async (j, i) => {
      const at = Date.now();
      try {
        return await j.run();
      } finally {
        timings[i] = Date.now() - at;
      }
    }),
  );
  const tracked = listTracked();
  const results = deduplicate(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
    .map((m) => {
      const t = tracked.find(
        (t) =>
          t.type === m.type &&
          ((m.anilistId !== null && t.anilistId === m.anilistId) ||
            (m.mangadexId !== null && t.mangadexId === m.mangadexId) ||
            t.media.id === m.id),
      );
      return { ...m, trackedId: t?.id ?? null, kavitaSeriesId: t?.kavitaSeriesId ?? null };
    })
    .map((m) => ({ m, rank: relevance(m, query) }))
    .sort((a, b) => b.rank - a.rank)
    .map(({ m }) => m);
  const value: SearchResponse = {
    results,
    providers: settled.map((r, i) => ({
      provider: jobs[i].provider,
      status: r.status === 'fulfilled' ? 'ok' : 'error',
      durationMs: timings[i],
    })),
    durationMs: Date.now() - start,
  };
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}
