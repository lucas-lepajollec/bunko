import { searchComics, metronConfigured, metronScope } from './metron';
import { searchHardcover, hardcoverConfigured } from './hardcover';
import { credentialScope } from './catalog-provider-http';
import { getSettings } from './settings';
import { sourceResultVisibility } from './source-visibility';
import { enrichNovelRecords, resolvedNovelRecord } from './novels';
import { searchBooks } from './openlibrary';
import { isTextKind } from './library-kinds';
import { sourceFormat } from './library-kinds';
import {
  visibleMedia,
  includeProviderAdults,
  adultKey,
  adultScope,
  nsfwSourceFilter,
  rememberAdultIdentities,
} from './adult';
import { mangaUpdates } from './mangaupdates';
import type { MediaType, Provider, SearchResponse, UnifiedMedia } from '@/types/shared';
import { db, searchCatalog, listTracked } from './db';
import { withTracking } from './catalog';
import { requestJson } from './http';
import {
  aniFields,
  authorsMatch,
  canonicalTitle,
  DEX_DOUJINSHI,
  emptyMedia,
  fromAniList,
  fromMangaDex,
  fromMangaUpdates,
  hasEditionQualifier,
  isUnwantedUpdatesType,
  normalizeTitle,
  relevance,
  type AniMedia,
  type DexManga,
  type UpdatesRecord,
} from './media';
import { anilistOfTmdbMovie, animeIdsReady, tmdbEntries } from './anime-ids';
import { indexedSeries } from './kavita-index';
import { kavitaMedia } from './kavita-track';
import { cached, storedMetadata, metadataStatus } from './metadata-cache';
export { emptyMedia, normalizeTitle };
function identities(m: UnifiedMedia) {
  const out = new Set<string>();
  for (const raw of [m.title, ...m.altTitles]) {
    const exact = normalizeTitle(raw);
    if (exact) out.add(exact);
    const canon = canonicalTitle(raw);
    if (canon) out.add(canon);
  }
  return [...out];
}
const PROVIDER_RANK: Record<string, number> = {
  anilist: 0,
  mangadex: 1,
  mangaupdates: 2,
  hardcover: 3,
  openlibrary: 4,
  metron: 5,
  tmdbtv: 6,
  tmdbmovie: 6,
  googlebooks: 7,
  bnf: 8,
  rakuten: 8,
  royalroad: 8,
  kavita: 9,
  suwayomi: 10,
  jellyfin: 10,
  ext: 11,
};
const providerOf = (m: UnifiedMedia) => m.id.slice(0, m.id.indexOf(':'));
const providerRank = (m: UnifiedMedia) => PROVIDER_RANK[providerOf(m)] ?? 12;
const isLocalItem = (m: UnifiedMedia) =>
  m.id.startsWith('kavita:') ||
  m.id.startsWith('suwayomi:') ||
  m.id.startsWith('jellyfin:') ||
  m.id.startsWith('stash:');

function effectiveFormat(m: UnifiedMedia): string | null {
  if (m.format) return m.format;
  // AniList anime TV/OVA have format=null; distinguish from TMDB SERIES/MOVIE so live-action
  // shows/films never falsely merge with an anime sharing the same title and year.
  if (m.type === 'ANIME' && m.anilistId) return 'ANIME';
  return null;
}

function formatsCompatible(a: UnifiedMedia, b: UnifiedMedia): boolean {
  const fa = effectiveFormat(a);
  const fb = effectiveFormat(b);
  if (!fa || !fb || fa === fb) return true;
  // Manga & One-Shot belong to the same manga kind (`kinds.ts`).
  if ((fa === 'MANGA' && fb === 'ONE_SHOT') || (fa === 'ONE_SHOT' && fb === 'MANGA')) return true;
  // Local Kavita/Suwayomi items infer format heuristically from library/source names.
  if (isLocalItem(a) || isLocalItem(b)) return true;
  // Cross-provider book/novel heuristics (`NOVEL` vs `BOOK`, or AniList `LIGHT_NOVEL` vs
  // Hardcover/OpenLibrary `NOVEL` which have no distinct LN format) when creators match.
  const pair = new Set([fa, fb]);
  const crossBook =
    providerOf(a) !== providerOf(b) &&
    ((pair.has('NOVEL') && pair.has('BOOK')) || (pair.has('LIGHT_NOVEL') && pair.has('NOVEL')));
  if (crossBook && authorsMatch(a.authors, b.authors)) return true;
  return false;
}

export function deduplicate(input: UnifiedMedia[]): UnifiedMedia[] {
  const output: UnifiedMedia[] = [];
  const exact = new Map<string, UnifiedMedia>();
  const providerIds = new WeakMap<UnifiedMedia, Map<string, string>>();
  const ids = (m: UnifiedMedia) => {
    const entries: [string, string][] = [
      [providerOf(m), m.id.slice(m.id.indexOf(':') + 1)],
      ...(m.anilistId ? ([['anilist', String(m.anilistId)]] as [string, string][]) : []),
      ...(m.mangadexId ? ([['mangadex', m.mangadexId]] as [string, string][]) : []),
      ...(m.mangaUpdatesId ? ([['mangaupdates', m.mangaUpdatesId]] as [string, string][]) : []),
      ...(m.kavitaSeriesId ? ([['kavita', String(m.kavitaSeriesId)]] as [string, string][]) : []),
      ...m.sources.map(
        (s) => [`suwayomi:${s.sourceId}`, String(s.suwayomiMangaId)] as [string, string],
      ),
    ];
    // Bridge TMDB animated films/shows that map to an AniList anime in the offline id table.
    if (m.type === 'ANIME' && animeIdsReady()) {
      if (m.id.startsWith('tmdbmovie:')) {
        const mapped = anilistOfTmdbMovie(Number(m.id.slice(10)));
        if (mapped) entries.push(['anilist', String(mapped)]);
      } else if (m.id.startsWith('tmdbtv:')) {
        const mapped = tmdbEntries(Number(m.id.slice(7)))[0]?.anilist;
        if (mapped) entries.push(['anilist', String(mapped)]);
      }
    }
    return new Map(entries);
  };
  const sameWork = (m: UnifiedMedia, other: UnifiedMedia) => {
    const left = providerIds.get(m) ?? ids(m),
      right = ids(other);
    const sameProviderConflict = [...right].some(([p, id]) => left.has(p) && left.get(p) !== id);
    const linked = [...right].some(([p, id]) => left.get(p) === id);
    if (linked && !sameProviderConflict) return true;
    // Allow collapsing same-provider book edition duplicates (e.g. "Dune" + "Dune (Deluxe Edition)")
    // ONLY when an explicit edition qualifier is present and creators match; plain homonyms stay apart.
    if (sameProviderConflict) {
      const p = providerOf(m);
      return (
        p === providerOf(other) &&
        (p === 'openlibrary' || p === 'hardcover') &&
        (hasEditionQualifier(m.title) || hasEditionQualifier(other.title)) &&
        canonicalTitle(m.title) === canonicalTitle(other.title) &&
        authorsMatch(m.authors, other.authors) &&
        (!m.year || !other.year || Math.abs(m.year - other.year) <= 1)
      );
    }
    if (!formatsCompatible(m, other)) return false;
    if (m.year && other.year && Math.abs(m.year - other.year) > 1) return false;
    // A title alone is insufficient for western comics/books; require a shared creator
    // (except local Kavita/Suwayomi entries which never carry authors, or MU LN summaries).
    if (isTextKind(m) || isTextKind(other) || m.format === 'COMIC' || other.format === 'COMIC') {
      if (authorsMatch(m.authors, other.authors)) return true;
      if ((isLocalItem(m) || isLocalItem(other)) && (!m.authors.length || !other.authors.length))
        return true;
      return (
        (m.format === 'LIGHT_NOVEL' || other.format === 'LIGHT_NOVEL') &&
        ((m.id.startsWith('mangaupdates:') && !m.authors.length) ||
          (other.id.startsWith('mangaupdates:') && !other.authors.length))
      );
    }
    return !m.authors.length || !other.authors.length || authorsMatch(m.authors, other.authors);
  };
  const aliases = new Map<string, UnifiedMedia[]>();
  const index = (m: UnifiedMedia) => {
    for (const [provider, id] of providerIds.get(m) ?? ids(m))
      exact.set(`${m.type}:${provider}:${id}`, m);
    for (const key of identities(m)) {
      const name = `${m.type}:${key}`;
      const list = aliases.get(name) ?? [];
      // Ambiguous aliases never turn into an unbounded candidate scan.
      if (list.length < 8 && !list.includes(m)) list.push(m);
      aliases.set(name, list);
    }
  };
  // Prefer plain canonical titles before edition-tagged duplicates when both appear in the same list.
  const ordered = input
    .map((media, idx) => ({ media, idx }))
    .sort((a, b) => {
      const ea = Number(hasEditionQualifier(a.media.title));
      const eb = Number(hasEditionQualifier(b.media.title));
      if (ea !== eb && canonicalTitle(a.media.title) === canonicalTitle(b.media.title))
        return ea - eb;
      return a.idx - b.idx;
    })
    .map((x) => x.media);
  for (const media of ordered) {
    const keys = identities(media);
    const candidates = new Set(keys.flatMap((k) => aliases.get(`${media.type}:${k}`) ?? []));
    const exactTarget = [...ids(media)]
      .flatMap(([p, id]) => exact.get(`${media.type}:${p}:${id}`) ?? [])
      .find((m) => sameWork(m, media));
    const target =
      (exactTarget && sameWork(exactTarget, media) ? exactTarget : undefined) ??
      [...candidates].find(
        (m) =>
          sameWork(m, media) &&
          !(m.anilistId && media.anilistId && m.anilistId !== media.anilistId) &&
          !(m.mangadexId && media.mangadexId && m.mangadexId !== media.mangadexId),
      );
    if (!target) {
      const copy = structuredClone(media);
      providerIds.set(copy, ids(copy));
      output.push(copy);
      index(copy);
      continue;
    }
    // Deterministic canonical winner: a strictly higher-priority catalog provider (e.g.
    // Hardcover over OpenLibrary, AniList over MangaUpdates) keeps its id/title regardless of
    // which progressive lane finished first.
    if (
      providerRank(media) < providerRank(target) &&
      !target.trackedId &&
      !hasEditionQualifier(media.title)
    ) {
      target.altTitles = [
        ...new Set([target.title, ...target.altTitles, ...media.altTitles]),
      ].filter((t) => t !== media.title);
      target.id = media.id;
      target.title = media.title;
      if (media.format) target.format = media.format;
      if (media.coverUrl) target.coverUrl = media.coverUrl;
    } else {
      target.altTitles = [
        ...new Set([...target.altTitles, media.title, ...media.altTitles]),
      ].filter((t) => t !== target.title);
    }
    target.adult = Boolean(target.adult || media.adult);
    providerIds.set(target, new Map([...(providerIds.get(target) ?? ids(target)), ...ids(media)]));
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
      'kavitaSeriesId',
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
    if (target.format === 'NOVEL' && media.format === 'LIGHT_NOVEL') target.format = 'LIGHT_NOVEL';
    target.genres = [...new Set([...target.genres, ...media.genres])];
    if ((media.startDate?.length ?? 0) > (target.startDate?.length ?? 0))
      target.startDate = media.startDate;
    target.authors = [...new Set([...target.authors, ...media.authors])];
    index(target);
  }
  return output;
}
async function anilist(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
): Promise<UnifiedMedia[]> {
  const body = {
    query: `query($search: String!, $type: MediaType!) { Page(perPage: 30) { media(search: $search, type: $type${adultScope() === 'only' ? ', isAdult: true' : includeProviderAdults() ? '' : ', isAdult: false'}) { ${aniFields} staff(perPage: 10) { edges { role node { name { full } } } } } } }`,
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
  (adultScope() === 'only'
    ? ['erotica', 'pornographic']
    : includeProviderAdults()
      ? ['safe', 'suggestive', 'erotica', 'pornographic']
      : ['safe', 'suggestive']
  ).forEach((v) => url.searchParams.append('contentRating[]', v));
  url.searchParams.append('excludedTags[]', DEX_DOUJINSHI);
  const r = await requestJson<{ data: DexManga[] }>(url, { signal }, 2500);
  return r.data.map(fromMangaDex);
}
async function mangaupdates(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
): Promise<UnifiedMedia[]> {
  const r = await mangaUpdates<{ results: { record: UpdatesRecord }[] }>(
    '/series/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: query, perpage: 30 }),
      signal: signal ?? AbortSignal.timeout(2500),
    },
    2500,
  );
  const summaries = r.results.map(({ record }) => record);
  enrichNovelRecords(summaries);
  const records = summaries.map(resolvedNovelRecord);
  return records
    .filter((m) => !isUnwantedUpdatesType(m.type))
    .filter((m) => type !== 'NOVEL' || /novel/i.test(m.type ?? ''))
    .filter((m) => type !== 'MANGA' || !/novel/i.test(m.type ?? ''))
    .map(fromMangaUpdates);
}
export async function search(
  query: string,
  type?: MediaType,
  signal?: AbortSignal,
  fast = false,
  progressive = false,
): Promise<SearchResponse> {
  const start = Date.now();
  const key = `${adultKey()}:${type}:${query.toLowerCase()}`;
  const jobs: { provider: Provider; cacheProvider?: string; run: () => Promise<UnifiedMedia[]> }[] =
    [{ provider: 'anilist', run: () => anilist(query, type) }];
  if (!type || type === 'MANGA') jobs.push({ provider: 'mangadex', run: () => mangadex(query) });
  if (type !== 'ANIME')
    jobs.push({ provider: 'mangaupdates', run: () => mangaupdates(query, type) });
  if (!type || type === 'NOVEL')
    jobs.push({ provider: 'local', cacheProvider: 'openlibrary', run: () => searchBooks(query) });
  if ((!type || type === 'MANGA') && metronConfigured())
    jobs.push({
      provider: 'local',
      cacheProvider: `metron:${metronScope()}`,
      run: () => searchComics(query),
    });
  if ((!type || type === 'NOVEL') && hardcoverConfigured())
    jobs.push({
      provider: 'local',
      cacheProvider: `hardcover:${credentialScope(getSettings().hardcoverToken)}`,
      run: () => searchHardcover(query),
    });
  const sourceVisible = sourceResultVisibility();
  const sourceAllowedById = nsfwSourceFilter();
  if (type !== 'ANIME')
    jobs.push({
      provider: 'local',
      run: async () => {
        const tracked = listTracked();
        const ownedSeries = new Set(
          tracked.map((t) => t.kavitaSeriesId ?? t.media.kavitaSeriesId).filter(Boolean),
        );
        return [
          ...tracked
            .map((t) => ({
              ...t.media,
              kavitaSeriesId: t.kavitaSeriesId ?? t.media.kavitaSeriesId,
              sources: t.media.sources.length
                ? t.media.sources
                : t.sources.map((s) => ({
                    sourceId: s.sourceId,
                    sourceName: s.sourceName,
                    suwayomiMangaId: s.suwayomiMangaId,
                    title: t.title,
                    mangaUrl: '',
                    thumbnailUrl: null,
                    lang: '',
                  })),
            }))
            .filter(
              (m) =>
                (!type || m.type === type) &&
                [m.title, ...m.altTitles].some((n) =>
                  normalizeTitle(n).includes(normalizeTitle(query)),
                ),
            ),
          ...searchCatalog(query)
            .filter(() => type !== 'NOVEL')
            .filter((r) => sourceAllowedById(r.sourceId))
            .filter((r) => sourceVisible(r.suwayomiMangaId, r.title))
            .map((r) => ({
              ...emptyMedia(`suwayomi:${r.suwayomiMangaId}`, r.title, 'MANGA'),
              format: sourceFormat(r.sourceName),
              sources: [r],
              providers: ['local' as const],
            })),
          ...indexedSeries()
            .filter(
              (s) =>
                !ownedSeries.has(s.seriesId) &&
                (!type ||
                  (isTextKind({ format: s.kind ?? null, type: 'MANGA' }) ? 'NOVEL' : 'MANGA') ===
                    type) &&
                s.names.some((n) => normalizeTitle(n).includes(normalizeTitle(query))),
            )
            .slice(0, 100)
            .map((s) => kavitaMedia(s.seriesId)),
        ];
      },
    });
  const timings: number[] = [];
  const cacheKeys = jobs.map((j) =>
    j.provider === 'local' && !j.cacheProvider
      ? null
      : `search:${j.cacheProvider ?? j.provider}:${key}`,
  );
  const settled = await Promise.allSettled(
    jobs.map(async (j, i) => {
      const at = Date.now();
      try {
        signal?.throwIfAborted();
        if (fast && (j.provider !== 'local' || j.cacheProvider))
          return (
            storedMetadata<UnifiedMedia[]>(`search:${j.cacheProvider ?? j.provider}:${key}`)
              ?.value ?? []
          );
        return j.provider === 'local' && !j.cacheProvider
          ? await j.run()
          : await cached(
              `search:${j.cacheProvider ?? j.provider}:${key}`,
              30_000,
              j.run,
              progressive ? { initial: () => [] } : {},
            );
      } finally {
        timings[i] = Date.now() - at;
      }
    }),
  );
  const merged = deduplicate(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  db().transaction(() => merged.forEach((m) => rememberAdultIdentities(m)))();
  const results = withTracking(merged)
    .filter(visibleMedia)
    .map((m) => ({ m, rank: relevance(m, query) }))
    .sort((a, b) => b.rank - a.rank)
    .map(({ m }) => m);
  const value: SearchResponse = {
    results,
    pending: !fast && cacheKeys.some((key) => key && metadataStatus(key).pending),
    providers: [...new Set(jobs.map((job) => job.provider))].map((provider) => {
      const indices = jobs.flatMap((job, i) => (job.provider === provider ? [i] : []));
      return {
        provider,
        status: indices.some(
          (i) =>
            settled[i].status === 'rejected' ||
            (cacheKeys[i] && metadataStatus(cacheKeys[i]!).partial),
        )
          ? ('error' as const)
          : ('ok' as const),
        durationMs: Math.max(...indices.map((i) => timings[i])),
      };
    }),
    durationMs: Date.now() - start,
    ...(fast ? { partial: true } : {}),
  };
  return value;
}
