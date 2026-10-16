import type { MediaFormat, MediaType, UnifiedMedia } from '@/types/shared';
export function emptyMedia(id: string, title: string, type: MediaType): UnifiedMedia {
  return {
    id,
    adult: false,
    title,
    type,
    altTitles: [],
    anilistId: null,
    mangadexId: null,
    mangaUpdatesId: null,
    coverUrl: null,
    bannerUrl: null,
    synopsis: null,
    genres: [],
    authors: [],
    score: null,
    status: null,
    chapters: null,
    episodes: null,
    webUrl: null,
    providers: [],
    sources: [],
    trackedId: null,
    kavitaSeriesId: null,
    kavita: null,
    format: null,
    origin: null,
    year: null,
    volumes: null,
    color: null,
    popularity: null,
    startDate: null,
  };
}
export function normalizeTitle(title: string) {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
/** Provider synopses carry HTML fragments, entities and trailing source credits. */
export function cleanSynopsis(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n?\s*\((?:source|from)[^)]*\)\s*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}
export function formatFor(kind: 'comic' | 'novel' | 'oneshot', origin: string | null): MediaFormat {
  if (kind === 'novel')
    return origin === 'KR' || origin === 'CN' || origin === 'TW' ? 'WEB_NOVEL' : 'LIGHT_NOVEL';
  if (kind === 'oneshot') return 'ONE_SHOT';
  if (origin === 'KR') return 'MANHWA';
  if (origin === 'CN' || origin === 'TW' || origin === 'HK') return 'MANHUA';
  return 'MANGA';
}
export interface AniMedia {
  isAdult?: boolean;
  id: number;
  type: string;
  format: string | null;
  countryOfOrigin?: string | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms?: string[];
  coverImage: { extraLarge: string | null; color?: string | null };
  bannerImage: string | null;
  description?: string | null;
  genres?: string[];
  averageScore: number | null;
  popularity?: number | null;
  status: string | null;
  chapters: number | null;
  volumes?: number | null;
  episodes?: number | null;
  siteUrl: string;
  startDate?: { year: number | null; month?: number | null; day?: number | null } | null;
  staff?: { edges: { role: string; node: { name: { full: string } } }[] };
}
export const aniFields =
  'id isAdult type format countryOfOrigin title { romaji english native } synonyms coverImage { extraLarge color } bannerImage description(asHtml: false) genres averageScore popularity status chapters volumes episodes siteUrl startDate { year month day }';
export function fromAniList(m: AniMedia): UnifiedMedia {
  const novel = m.format === 'NOVEL';
  const type: MediaType = m.type === 'ANIME' ? 'ANIME' : novel ? 'NOVEL' : 'MANGA';
  const origin = m.countryOfOrigin ?? null;
  return {
    ...emptyMedia(
      `anilist:${m.id}`,
      m.title.english ?? m.title.romaji ?? m.title.native ?? String(m.id),
      type,
    ),
    adult: Boolean(m.isAdult),
    anilistId: m.id,
    altTitles: [
      ...new Set([
        ...Object.values(m.title).filter((v): v is string => Boolean(v)),
        ...(m.synonyms ?? []),
      ]),
    ],
    coverUrl: m.coverImage.extraLarge,
    bannerUrl: m.bannerImage,
    synopsis: cleanSynopsis(m.description),
    genres: m.genres ?? [],
    authors: (m.staff?.edges ?? [])
      .filter((e) => /story|original|author/i.test(e.role))
      .map((e) => e.node.name.full),
    score: m.averageScore,
    status: m.status,
    chapters: m.chapters,
    episodes: m.episodes ?? null,
    webUrl: m.siteUrl,
    providers: ['anilist'],
    format:
      type === 'ANIME'
        ? null
        : formatFor(novel ? 'novel' : m.format === 'ONE_SHOT' ? 'oneshot' : 'comic', origin),
    origin,
    year: m.startDate?.year ?? null,
    startDate: m.startDate?.year
      ? [
          m.startDate.year,
          ...(m.startDate.month
            ? [m.startDate.month, ...(m.startDate.day ? [m.startDate.day] : [])]
            : []),
        ]
          .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0'))
          .join('-')
      : null,
    volumes: m.volumes ?? null,
    color: m.coverImage.color ?? null,
    popularity: m.popularity ?? null,
  };
}
export interface DexManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    description: Record<string, string>;
    status: string;
    year?: number | null;
    originalLanguage?: string;
    contentRating?: string;
    links?: Record<string, string> | null;
    tags: { id?: string; attributes: { name: Record<string, string> } }[];
  };
  relationships: { type: string; attributes?: { fileName?: string; name?: string } }[];
}
const dexOrigin: Record<string, string> = {
  ja: 'JP',
  ko: 'KR',
  zh: 'CN',
  'zh-hk': 'HK',
  en: 'US',
  fr: 'FR',
};
export const DEX_DOUJINSHI = 'b13b2a48-c720-44a9-9c77-39c9979373fb';
const DEX_ONESHOT = '0234a31e-a729-4e28-9d6a-3f87c4966b9e';
export function fromMangaDex(m: DexManga): UnifiedMedia {
  const a = m.attributes;
  const cover = m.relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const origin = a.originalLanguage ? (dexOrigin[a.originalLanguage] ?? null) : null;
  return {
    ...emptyMedia(
      `mangadex:${m.id}`,
      a.title.fr ?? a.title.en ?? Object.values(a.title)[0],
      'MANGA',
    ),
    adult: ['erotica', 'pornographic'].includes(a.contentRating ?? ''),
    mangadexId: m.id,
    anilistId: a.links?.al && /^\d+$/.test(a.links.al) ? Number(a.links.al) : null,
    altTitles: [...new Set([...Object.values(a.title), ...a.altTitles.flatMap(Object.values)])],
    coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}.512.jpg` : null,
    synopsis: cleanSynopsis(a.description.fr ?? a.description.en ?? null),
    status: a.status,
    genres: a.tags.map((t) => t.attributes.name.en).filter(Boolean),
    authors: [
      ...new Set(
        m.relationships
          .filter((r) => (r.type === 'author' || r.type === 'artist') && r.attributes?.name)
          .map((r) => r.attributes!.name!),
      ),
    ],
    webUrl: `https://mangadex.org/title/${m.id}`,
    providers: ['mangadex'],
    format: formatFor(a.tags.some((t) => t.id === DEX_ONESHOT) ? 'oneshot' : 'comic', origin),
    origin,
    year: a.year ?? null,
    startDate: a.year == null ? null : String(a.year).padStart(4, '0'),
  };
}
export interface UpdatesRecord {
  series_id: number;
  title: string;
  url: string;
  description?: string;
  image?: { url?: { original?: string } };
  type?: string;
  year?: string;
  status?: string;
  associated?: { title: string }[];
  genres?: { genre: string }[];
  authors?: { name: string; type: string }[];
  bayesian_rating?: number | null;
}
const updatesFormat: Record<string, ['comic' | 'novel' | 'oneshot', string | null]> = {
  manga: ['comic', 'JP'],
  manhwa: ['comic', 'KR'],
  manhua: ['comic', 'CN'],
  novel: ['novel', null],
  oel: ['comic', 'US'],
  french: ['comic', 'FR'],
};
/** MangaUpdates types excluded from reading results: fan works and non-series material. */
export function isUnwantedUpdatesType(type: string | undefined) {
  return /doujinshi|artbook|drama cd|filipino|indonesian|thai|vietnamese|malaysian/i.test(
    type ?? '',
  );
}
export function fromMangaUpdates(m: UpdatesRecord): UnifiedMedia {
  const [kind, origin] = updatesFormat[(m.type ?? '').toLowerCase()] ?? ['comic', null];
  return {
    ...emptyMedia(`mangaupdates:${m.series_id}`, m.title, kind === 'novel' ? 'NOVEL' : 'MANGA'),
    adult: (m.genres ?? []).some((g) => /^(adult|hentai|smut)$/i.test(g.genre)),
    mangaUpdatesId: String(m.series_id),
    coverUrl: m.image?.url?.original ?? null,
    synopsis: cleanSynopsis(m.description),
    altTitles: m.associated?.map((t) => t.title) ?? [],
    genres: m.genres?.map((g) => g.genre) ?? [],
    authors: [...new Set((m.authors ?? []).map((a) => a.name))],
    score: m.bayesian_rating ? Math.round(m.bayesian_rating * 10) : null,
    webUrl: m.url,
    providers: ['mangaupdates'],
    format: formatFor(kind, origin),
    origin,
    year: m.year && /^\d{4}$/.test(m.year) ? Number(m.year) : null,
    startDate: m.year && /^\d{4}$/.test(m.year) ? m.year : null,
  };
}
/** Relevance of a result for a query: title match first, then catalogue quality signals. */
export function relevance(media: UnifiedMedia, query: string) {
  const q = normalizeTitle(query);
  const titles = [media.title, ...media.altTitles].map(normalizeTitle).filter(Boolean);
  let score = 0;
  if (titles.includes(q)) score = 100;
  else if (titles.some((t) => t.startsWith(q))) score = 70;
  else if (titles.some((t) => t.includes(q))) score = 45;
  else score = 10;
  if (media.anilistId) score += 12;
  if (media.coverUrl) score += 6;
  if (media.popularity) score += Math.min(15, Math.log10(media.popularity + 1) * 3);
  return score;
}
