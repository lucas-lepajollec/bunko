import type { DiscoverPage, DiscoverQuery, MediaDetail, UnifiedMedia } from '@/types/shared';
import { emptyMedia, cleanSynopsis } from './media';
import { cached } from './metadata-cache';
import { sharedConcurrencyGate } from './concurrency';
import { BUNKO_USER_AGENT } from './mangaupdates';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors';

const serial = sharedConcurrencyGate('openlibrary', 1);
const scope = globalThis as typeof globalThis & { __bunkoOlNext?: number };
const DAY = 86400_000;
/** Metadata is tenant-local; only public-provider pacing is shared across tenants/bundles. */
export function openLibraryJson<T>(path: string, ttl = DAY): Promise<T> {
  return cached(`openlibrary:${path}`, ttl, () =>
    serial(async () => {
      const signal = AbortSignal.timeout(15_000);
      const wait = Math.max(0, (scope.__bunkoOlNext ?? 0) - Date.now());
      if (wait > 60_000) throw new AppError('RATE_LIMITED', 'Open Library is cooling down', 502);
      if (wait) await delay(wait, undefined, { signal });
      scope.__bunkoOlNext = Date.now() + 1000;
      const response = await fetch(`https://openlibrary.org${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': BUNKO_USER_AGENT },
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const value = response.headers.get('retry-after');
          const retry = /^\d+$/.test(value ?? '')
            ? Number(value) * 1000
            : Date.parse(value ?? '') - Date.now();
          scope.__bunkoOlNext =
            Date.now() + Math.max(1000, Number.isFinite(retry) ? retry : 60_000);
        }
        await response.body?.cancel();
        throw new AppError(
          response.status === 404 ? 'NOT_FOUND' : 'METADATA_UNAVAILABLE',
          'Open Library request failed',
          response.status === 404 ? 404 : 502,
        );
      }
      return (await response.json()) as T;
    }).catch((error) => {
      if (error instanceof AppError) throw error;
      throw new AppError('METADATA_UNAVAILABLE', 'Open Library request failed', 502);
    }),
  );
}
// A fiction subject wins over topical subjects (e.g. "History, Fiction"). Unknown books default to fiction.
export function bookFormat(subjects: string[]): 'NOVEL' | 'BOOK' {
  if (
    subjects.some((s) =>
      /\b(non[ -]?fiction|essays?|biograph(?:y|ies|ical)?|autobiograph(?:y|ies|ical)?|memoirs?|manuals?|textbooks?|self.help)\b/i.test(
        s,
      ),
    )
  )
    return 'BOOK';
  if (subjects.some((s) => /\b(fiction|novels?|stories|fantasy|romance|mystery)\b/i.test(s)))
    return 'NOVEL';
  return subjects.some((s) =>
    /\b(history|science|philosophy|religion|politics|economics|mathematics|cooking|technology|travel|business|psychology|education|art|poetry)\b/i.test(
      s,
    ),
  )
    ? 'BOOK'
    : 'NOVEL';
}
export interface OpenLibraryDoc {
  key: string;
  title: string;
  alternative_title?: string[];
  author_name?: string[];
  authors?: { name?: string; key?: string; author?: { key: string } }[];
  subject?: string[];
  subjects?: string[];
  cover_i?: number;
  cover_id?: number;
  covers?: number[];
  edition_count?: number;
  first_publish_year?: number;
  first_publish_date?: string;
  ratings_average?: number;
  readinglog_count?: number;
  description?: string | { value: string };
}
const workId = (key: string) => /^(?:\/works\/)?(OL[1-9]\d*W)$/.exec(key)?.[1];
export function fromOpenLibrary(
  doc: OpenLibraryDoc,
): UnifiedMedia & { editionCount: number | null } {
  const id = workId(doc.key);
  if (!id) throw new AppError('METADATA_UNAVAILABLE', 'Invalid Open Library work', 502);
  const subjects = doc.subject ?? doc.subjects ?? [];
  const cover = doc.cover_i ?? doc.cover_id ?? doc.covers?.find((n) => n > 0);
  const date = doc.first_publish_date?.match(/\b\d{4}\b/)?.[0];
  const year = doc.first_publish_year ?? (date ? Number(date) : null);
  return {
    ...emptyMedia(`openlibrary:${id}`, doc.title, 'NOVEL'),
    altTitles: doc.alternative_title ?? [],
    format: bookFormat(subjects),
    genres: subjects.slice(0, 100),
    adult: subjects.some((s) => /\b(erotica|pornography|erotic fiction)\b/i.test(s)),
    authors: doc.author_name ?? doc.authors?.flatMap((a) => (a.name ? [a.name] : [])) ?? [],
    coverUrl: cover && cover > 0 ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : null,
    synopsis: cleanSynopsis(
      typeof doc.description === 'string' ? doc.description : doc.description?.value,
    ),
    year,
    startDate: year ? String(year) : null,
    // Keep the frozen Provider union; editionCount is an additive API field.
    providers: ['local'],
    editionCount: doc.edition_count ?? null,
    volumes: null,
    score: doc.ratings_average == null ? null : Math.min(100, Math.round(doc.ratings_average * 20)),
    popularity: doc.readinglog_count ?? null,
    webUrl: `https://openlibrary.org/works/${id}`,
  };
}
interface SearchResult {
  docs: OpenLibraryDoc[];
  numFound?: number;
  num_found?: number;
  start?: number;
}
const fields =
  'key,title,alternative_title,author_name,subject,cover_i,edition_count,first_publish_year,ratings_average,readinglog_count';
export async function searchBooks(query: string): Promise<UnifiedMedia[]> {
  const params = new URLSearchParams({ q: query, limit: '30', fields });
  const data = await openLibraryJson<SearchResult>(`/search.json?${params}`, 30 * 60_000);
  return data.docs.filter((d) => workId(d.key)).map(fromOpenLibrary);
}
export async function discoverBooks(q: DiscoverQuery): Promise<DiscoverPage> {
  const page = q.page ?? 1,
    perPage = q.perPage ?? 24;
  // Search's subject facets and documented trending/readinglog/rating sorts avoid N+1 sheet requests.
  const subject =
    q.kind === 'book'
      ? '(subject:nonfiction OR subject:history OR subject:science OR subject:biography)'
      : 'subject:fiction';
  const year = new Date().getUTCFullYear();
  const query = [
    subject,
    q.genre ? `subject:${JSON.stringify(q.genre)}` : '',
    q.year ? `first_publish_year:${q.year}` : '',
    q.sort === 'new' ? `first_publish_year:[1 TO ${year}]` : '',
  ]
    .filter(Boolean)
    .join(' AND ');
  if (q.status || q.season) return { items: [], page, hasNextPage: false };
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    limit: String(perPage),
    fields,
    sort: { trending: 'trending', popular: 'readinglog', score: 'rating', new: 'new' }[
      q.sort ?? 'trending'
    ],
  });
  const data = await openLibraryJson<SearchResult>(`/search.json?${params}`, 30 * 60_000);
  const wanted = q.kind === 'book' ? 'BOOK' : 'NOVEL';
  return {
    items: data.docs
      .filter((d) => workId(d.key))
      .map(fromOpenLibrary)
      .filter(
        (m) =>
          m.format === wanted &&
          (q.year == null || m.year === q.year) &&
          (q.sort !== 'new' || (m.year != null && m.year <= year)),
      ),
    page,
    hasNextPage: page * perPage < (data.numFound ?? data.num_found ?? 0),
  };
}
export async function openLibraryDetail(id: string): Promise<MediaDetail> {
  if (!/^OL[1-9]\d*W$/.test(id))
    throw new AppError('VALIDATION_ERROR', 'Invalid Open Library work');
  const work = await openLibraryJson<OpenLibraryDoc>(`/works/${id}.json`, 7 * DAY);
  const editions = await openLibraryJson<{
    size: number;
    entries: { title?: string; publish_date?: string }[];
  }>(`/works/${id}/editions.json?limit=1`, 7 * DAY);
  const authors: string[] = [];
  for (const item of (work.authors ?? []).slice(0, 10)) {
    if (item.name) authors.push(item.name);
    else {
      const key = item.author?.key ?? item.key;
      if (key && /^\/authors\/OL[1-9]\d*A$/.test(key)) {
        const author = await openLibraryJson<{ name: string }>(`${key}.json`, 7 * DAY);
        authors.push(author.name);
      }
    }
  }
  // Search exposes the first year and total editions more reliably than work/edition publication strings.
  const info = await openLibraryJson<SearchResult>(
    `/search.json?${new URLSearchParams({ q: `key:/works/${id}`, fields, limit: '1' })}`,
    7 * DAY,
  );
  const doc = info.docs.find((d) => workId(d.key) === id);
  const media = fromOpenLibrary({
    ...doc,
    ...work,
    subject: work.subject ?? work.subjects ?? doc?.subject,
    key: `/works/${id}`,
    edition_count: editions.size,
    author_name: authors.length ? authors : doc?.author_name,
    first_publish_year: doc?.first_publish_year,
    alternative_title: [
      ...new Set([
        ...(doc?.alternative_title ?? []),
        ...editions.entries.flatMap((e) => (e.title ? [e.title] : [])),
      ]),
    ],
  });
  return { ...media, tags: media.genres, relations: [], recommendations: [] };
}
