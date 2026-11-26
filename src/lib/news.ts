import { createHash } from 'node:crypto';
import { KIND_IDS, KINDS, kindOfMedia, type Kind } from '@/domain/kinds';
import type { NewsFeed, NewsItem, NewsPage } from '@/types/shared';
import { includeProviderAdults, adultScope, visibleMedia } from './adult';
import { anilist, withTracking } from './catalog';
import { content, nodes, parseXml, type XmlNode } from './feed-xml';
import { aniFields, fromAniList, type AniMedia } from './media';
import { cached } from './metadata-cache';
import { releaseStore } from './releases';
import { readCapped, safeFetch } from './safe-fetch';
import { getSettings } from './settings';
import { preferredSourceLanguage } from './source-preferences';
import { fromTmdb, isAnime, tmdbConfigured, tmdbJson, type TmdbKind } from './tmdb';
import { decodeEntities, stripTags } from './html-text';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Items kept per source: a page of news, not an archive. */
const PER_SOURCE = 24;

/**
 * News of the chosen kinds, from what each kind's catalogs and sources already offer, plus the
 * feeds the user follows. Every source is optional: one that fails leaves its name in `failed`
 * and the others still answer.
 */
export async function newsPage(kinds: readonly Kind[]): Promise<NewsPage> {
  const failed = new Set<string>();
  const attempt = async (name: string, load: () => Promise<NewsItem[]>) => {
    try {
      return await load();
    } catch {
      failed.add(name);
      return [];
    }
  };
  const feeds = getSettings().newsFeeds.filter((f) => kinds.includes(f.kind));
  const lists = await Promise.all([
    ...kinds.flatMap((kind) => {
      const def = KINDS[kind];
      const out: Promise<NewsItem[]>[] = [];
      if (def.catalog.includes('anilist') && kind !== 'extension')
        out.push(attempt('AniList', () => aniListNews(kind)));
      if (def.catalog.includes('tmdb') && tmdbConfigured())
        out.push(attempt('TMDB', () => tmdbNews(kind)));
      if (def.family === 'reading') out.push(Promise.resolve(editionNews(kind)));
      return out;
    }),
    ...feeds.map((feed) => attempt(new URL(feed.url).host, () => feedNews(feed))),
  ]);
  // One entry per work: an announcement that is also coming soon is shown once, as coming.
  const byId = new Map<string, NewsItem>();
  for (const item of lists.flat()) {
    const key = item.media ? `${item.type === 'edition' ? item.id : item.media.id}` : item.id;
    const known = byId.get(key);
    if (!known || (known.type === 'announced' && item.type === 'upcoming')) byId.set(key, item);
  }
  const items = [...byId.values()];
  // Works shown with the user's own marks; 18+ ones only where the account shows them.
  const medias = withTracking(items.flatMap((i) => (i.media ? [i.media] : [])));
  const seen = new Map(medias.map((m) => [m.id, m]));
  return {
    items: items.flatMap((i) => {
      if (!i.media) return [i];
      const media = seen.get(i.media.id) ?? i.media;
      return visibleMedia(media) ? [{ ...i, media }] : [];
    }),
    failed: [...failed],
  };
}

/** YYYY, YYYY-MM or YYYY-MM-DD, as precise as the catalog knows it. */
function fuzzyDate(d: { year?: number | null; month?: number | null; day?: number | null } | null) {
  if (!d?.year) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.month
    ? d.day
      ? `${d.year}-${pad(d.month)}-${pad(d.day)}`
      : `${d.year}-${pad(d.month)}`
    : String(d.year);
}
const youtube = (t: { id?: string | null; site?: string | null } | null | undefined) =>
  t?.id && t.site?.toLowerCase() === 'youtube' && /^[\w-]{6,20}$/.test(t.id) ? t.id : null;

type NewsAniMedia = AniMedia & {
  trailer?: { id: string | null; site: string | null } | null;
  startDate?: { year: number | null; month: number | null; day: number | null } | null;
};

/**
 * AniList: works not out yet. Newest entries first are the latest announcements; the most
 * awaited ones with a date are what comes next.
 */
async function aniListNews(kind: Kind): Promise<NewsItem[]> {
  const variables: Record<string, unknown> = {
    type: kind === 'anime' || kind === 'animation' ? 'ANIME' : 'MANGA',
    adult: adultScope() === 'only' ? true : includeProviderAdults() ? undefined : false,
  };
  if (kind === 'lightnovel') variables.format = 'NOVEL';
  else if (kind === 'animation') variables.format = 'MOVIE';
  else if (kind === 'anime') variables.formatNot = 'MOVIE';
  else variables.formatNot = 'NOVEL';
  if (kind === 'manga') variables.country = 'JP';
  if (kind === 'manhwa') variables.country = 'KR';
  if (kind === 'manhua') variables.country = 'CN';
  const query = (
    sort: string,
  ) => `query($type: MediaType, $format: MediaFormat, $formatNot: MediaFormat, $country: CountryCode, $adult: Boolean) {
    Page(perPage: ${PER_SOURCE}) {
      media(type: $type, status: NOT_YET_RELEASED, sort: [${sort}], format: $format, format_not: $formatNot, countryOfOrigin: $country, isAdult: $adult) { ${aniFields} trailer { id site } }
    }
  }`;
  const load = (sort: string) =>
    cached(`news:anilist:${sort}:${JSON.stringify(variables)}`, 3 * HOUR, () =>
      anilist<{ Page: { media: NewsAniMedia[] } }>(query(sort), variables),
    );
  const [latest, awaited] = await Promise.all([load('ID_DESC'), load('POPULARITY_DESC')]);
  const item = (m: NewsAniMedia, type: 'announced' | 'upcoming'): NewsItem => {
    const media = fromAniList(m);
    return {
      id: `anilist:${m.id}`,
      type,
      kind: kindOfMedia(media),
      media,
      title: media.title,
      headline: null,
      summary: media.synopsis,
      imageUrl: media.bannerUrl ?? media.coverUrl,
      date: null,
      releaseDate: fuzzyDate(m.startDate ?? null),
      trailer: youtube(m.trailer),
      url: media.webUrl ?? null,
      source: 'AniList',
    };
  };
  return [
    ...latest.Page.media.map((m) => item(m, 'announced')),
    // Coming soon: only with a date, the nearest first.
    ...awaited.Page.media
      .filter((m) => m.startDate?.year)
      .map((m) => item(m, 'upcoming'))
      .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '')),
  ];
}

interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official?: boolean;
}
/** TMDB: series and films coming out, the most awaited first, each with its trailer. */
async function tmdbNews(kind: Kind): Promise<NewsItem[]> {
  const tmdbKind: TmdbKind = kind === 'series' ? 'tv' : 'movie';
  const today = new Date().toISOString().slice(0, 10);
  const lang = preferredSourceLanguage() ?? 'en';
  const language = { fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT' }[lang] ?? 'en-US';
  const params: Record<string, string> = {
    language,
    sort_by: 'popularity.desc',
    include_adult: 'false',
    ...(tmdbKind === 'tv'
      ? { 'first_air_date.gte': today }
      : { 'primary_release_date.gte': today, with_release_type: '2|3' }),
    // Animated films are their own kind; live-action films leave them out.
    ...(kind === 'animation'
      ? { with_genres: '16' }
      : kind === 'movies'
        ? { without_genres: '16' }
        : {}),
  };
  const page = await tmdbJson<{ results: Parameters<typeof fromTmdb>[0][] }>(
    `/discover/${tmdbKind}`,
    params,
    6 * HOUR,
  );
  // Anime come from AniList: a series of the anime kind is not repeated as a series.
  const results = page.results.filter((m) => !isAnime(m, tmdbKind)).slice(0, PER_SOURCE);
  const trailerOf = async (id: number) => {
    const pick = (videos: TmdbVideo[]) =>
      videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ??
      videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ??
      videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser');
    try {
      const local = await tmdbJson<{ results: TmdbVideo[] }>(
        `/${tmdbKind}/${id}/videos`,
        { language },
        DAY,
      );
      const found =
        pick(local.results) ??
        (language === 'en-US'
          ? undefined
          : pick(
              (await tmdbJson<{ results: TmdbVideo[] }>(`/${tmdbKind}/${id}/videos`, {}, DAY))
                .results,
            ));
      return found && /^[\w-]{6,20}$/.test(found.key) ? found.key : null;
    } catch {
      return null;
    }
  };
  // Trailers of the first ones only: a dozen lookups, each kept a day.
  const trailers = await Promise.all(results.map((m, i) => (i < 12 ? trailerOf(m.id) : null)));
  return results.map((m, i) => {
    const media = fromTmdb(m, tmdbKind);
    return {
      id: media.id,
      type: 'upcoming' as const,
      kind: kindOfMedia(media),
      media,
      title: media.title,
      headline: null,
      summary: media.synopsis,
      imageUrl: media.bannerUrl ?? media.coverUrl,
      date: null,
      releaseDate: media.startDate ?? null,
      trailer: trailers[i],
      url: media.webUrl ?? null,
      source: 'TMDB',
    };
  });
}

/** New volumes and editions of a reading kind, from the release sources Bunko already reads. */
function editionNews(kind: Kind): NewsItem[] {
  const now = Date.now();
  const from = new Date(now - 30 * DAY).toISOString().slice(0, 10);
  const to = new Date(now + 60 * DAY).toISOString().slice(0, 10);
  return releaseStore(new Date(), true)
    .filter(
      (r) =>
        r.unit === 'volume' &&
        !r.featured &&
        kindOfMedia(r.media) === kind &&
        r.releasedAt.slice(0, 10) >= from &&
        r.releasedAt.slice(0, 10) <= to,
    )
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))
    .slice(0, PER_SOURCE * 2)
    .map((r) => ({
      id: `edition:${r.id}`,
      type: 'edition' as const,
      kind,
      media: r.media,
      title: r.media.title,
      headline: r.label,
      summary: null,
      imageUrl: r.media.coverUrl,
      date: r.releasedAt,
      releaseDate: r.releasedAt.slice(0, 10),
      trailer: null,
      url: null,
      source: r.provider,
    }));
}

const stripHtml = (value: string) =>
  decodeEntities(stripTags(value, ' ')).replace(/\s+/g, ' ').trim();
const child = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);
const webAddress = (value: string | undefined | null) => {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};
const isoDate = (value: string | undefined) => {
  const time = value ? Date.parse(value.trim()) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Articles of an RSS or Atom feed (the newest first), parsed without running anything. */
export function parseNewsFeed(xml: string, feed: NewsFeed): NewsItem[] {
  const root = parseXml(xml);
  const channel = nodes(root, 'channel')[0] ?? nodes(root, 'feed')[0];
  const source =
    (channel && child(channel, 'title') ? content(child(channel, 'title')!) : '') ||
    new URL(feed.url).host;
  const entries = [...nodes(root, 'item'), ...nodes(root, 'entry')];
  return entries
    .map((entry): NewsItem | null => {
      const title = stripHtml(
        content(child(entry, 'title') ?? { name: '', attrs: {}, text: '', children: [] }),
      );
      if (!title) return null;
      const linkNode = entry.children.filter((c) => c.name === 'link');
      const link =
        webAddress(linkNode.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate')?.attrs.href) ??
        webAddress(linkNode.map((l) => l.text).find(Boolean));
      const description =
        child(entry, 'description') ?? child(entry, 'summary') ?? child(entry, 'content');
      const raw = description ? content(description) : '';
      const summary = stripHtml(raw).slice(0, 400) || null;
      const image =
        webAddress(child(entry, 'thumbnail')?.attrs.url) ??
        webAddress(
          entry.children.find((c) => c.name === 'enclosure' && /^image\//.test(c.attrs.type ?? ''))
            ?.attrs.url,
        ) ??
        webAddress(nodes(entry, 'content').find((c) => c.attrs.medium === 'image')?.attrs.url) ??
        webAddress(/<img[^>]+src=["']([^"']+)["']/i.exec(raw)?.[1]);
      const date = isoDate(
        content(
          child(entry, 'pubDate') ??
            child(entry, 'published') ??
            child(entry, 'updated') ??
            child(entry, 'date') ?? { name: '', attrs: {}, text: '', children: [] },
        ),
      );
      const id = createHash('sha1')
        .update(`${feed.url}|${link ?? title}`)
        .digest('hex')
        .slice(0, 16);
      return {
        id: `feed:${id}`,
        type: 'article',
        kind: feed.kind,
        media: null,
        title,
        headline: title,
        summary,
        // Feed images are shown through Bunko's image proxy only when the browser may load them.
        imageUrl: image,
        date,
        releaseDate: null,
        trailer: null,
        url: link,
        source,
      };
    })
    .filter((x): x is NewsItem => x !== null)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, PER_SOURCE);
}

async function feedNews(feed: NewsFeed): Promise<NewsItem[]> {
  const xml = await cached(`news:feed:${feed.url}`, HOUR, async () => {
    const response = await safeFetch(feed.url, {
      timeoutMs: 8000,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    });
    if (response.status < 200 || response.status >= 300) {
      response.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return (await readCapped(response, 3 * 1024 * 1024)).toString('utf8');
  });
  return parseNewsFeed(xml, feed);
}

/** The kinds a request names: one kind, or every kind given for "all" (unknown ones dropped). */
export function newsKinds(kind: string | null, kinds: string | null): Kind[] {
  const valid = (k: string): k is Kind => (KIND_IDS as readonly string[]).includes(k);
  if (kind && kind !== 'all') return valid(kind) ? [kind] : [];
  const list = (kinds ?? '').split(',').filter(valid);
  return list.length ? [...new Set(list)] : [...KIND_IDS];
}
