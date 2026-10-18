import type { DiscoverPage, DiscoverQuery, MediaDetail, UnifiedMedia } from '@/types/shared';
import { emptyMedia, cleanSynopsis } from './media';
import { bookFormat } from './openlibrary';
import { getSettings } from './settings';
import { providerJson, credentialScope } from './catalog-provider-http';
import { discoveryStatus } from './metadata-cache';
import { AppError } from './errors';
const DAY = 86400_000;
export interface HardcoverBook {
  id: number;
  title: string;
  slug?: string;
  alternative_titles?: string[];
  description?: string;
  image?: { url?: string };
  release_date?: string;
  release_year?: number;
  author_names?: string[];
  contributions?: { author?: { name: string } }[];
  literary_type_id?: number;
  cached_tags?: { Genre?: { tag?: string }[] };
  genres?: string[];
  rating?: number;
  users_count?: number;
  series_names?: string[];
  featured_series?: { name?: string };
  featured_series_position?: number;
  book_series?: { position?: number; series?: { id: number; name: string } }[];
  editions?: { id: number; title?: string; release_date?: string; isbn_13?: string }[];
}
export function hardcoverConfigured() {
  return Boolean(getSettings().hardcoverToken);
}
export async function hardcoverQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
  ttl = DAY,
): Promise<T> {
  const token = getSettings().hardcoverToken.replace(/^Bearer\s+/i, '');
  if (!token) throw new AppError('PROVIDER_UNCONFIGURED', 'Provider is not configured', 409);
  const response = await providerJson<{ data?: T; errors?: unknown[] }>(
    'hardcover',
    credentialScope(token, query, JSON.stringify(variables)),
    'https://api.hardcover.app/v1/graphql',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
    ttl,
    1100,
  );
  if (!response.data || response.errors?.length)
    throw new AppError('PROVIDER_QUERY_FAILED', 'Provider rejected query', 502);
  return response.data;
}
export function hardcoverMedia(row: HardcoverBook): UnifiedMedia {
  const genres = row.genres ?? (row.cached_tags?.Genre ?? []).flatMap((g) => g.tag ?? []);
  const date =
    row.release_date && /^\d{4}-\d{2}-\d{2}$/.test(row.release_date)
      ? row.release_date
      : row.release_year
        ? String(row.release_year)
        : null;
  return {
    ...emptyMedia(`hardcover:${row.id}`, row.title, 'NOVEL'),
    providers: ['local'],
    format:
      row.literary_type_id === 2
        ? 'BOOK'
        : row.literary_type_id === 1
          ? 'NOVEL'
          : bookFormat(genres),
    altTitles: row.alternative_titles ?? [],
    authors: row.author_names ?? (row.contributions ?? []).flatMap((c) => c.author?.name ?? []),
    genres,
    synopsis: cleanSynopsis(row.description),
    coverUrl: row.image?.url ?? null,
    year: row.release_year ?? (date ? Number(date.slice(0, 4)) : null),
    startDate: date,
    popularity: row.users_count ?? null,
    score: row.rating ? Math.min(100, row.rating * 20) : null,
    webUrl: row.slug ? `https://hardcover.app/books/${encodeURIComponent(row.slug)}` : null,
    adult: genres.some((g) => /^(erotica|erotic fiction)$/i.test(g)),
  };
}
const fields =
  'id title slug alternative_titles description image { url } release_date release_year contributions(limit: 10) { author { name } } literary_type_id cached_tags rating users_count';
export async function searchHardcover(query: string): Promise<UnifiedMedia[]> {
  if (!hardcoverConfigured()) return [];
  // Typesense full-text search is documented; SQL pattern operators are disabled.
  const result = await hardcoverQuery<{
    search: { results: { hits?: { document: HardcoverBook }[] } };
  }>(
    'query BunkoSearch($query: String!) { search(query: $query, query_type: "Book", per_page: 20, page: 1) { results } }',
    { query },
    3600_000,
  );
  return (result.search.results.hits ?? []).map((hit) => hardcoverMedia(hit.document));
}
export async function discoverHardcover(q: DiscoverQuery): Promise<DiscoverPage> {
  const page = q.page ?? 1;
  if (!hardcoverConfigured()) return { items: [], page, hasNextPage: false };
  const limit = q.perPage ?? 24;
  const order =
    q.sort === 'new'
      ? '{release_date: desc_nulls_last}'
      : q.sort === 'score'
        ? '{rating: desc_nulls_last}'
        : '{users_count: desc_nulls_last}';
  const query = `query BunkoDiscover($limit: Int!, $offset: Int!, $today: date!) { books(limit: $limit, offset: $offset, where: {release_date: {_lte: $today}}, order_by: ${order}) { ${fields} } }`;
  const variables = {
    limit,
    offset: (page - 1) * limit,
    today: new Date().toISOString().slice(0, 10),
  };
  const data = await hardcoverQuery<{ books: HardcoverBook[] }>(query, variables);
  const state = discoveryStatus(
    `optional:hardcover:${credentialScope(getSettings().hardcoverToken.replace(/^Bearer\s+/i, ''), query, JSON.stringify(variables))}`,
    'hardcover',
  );
  const items = data.books
    .map(hardcoverMedia)
    .filter(
      (m) =>
        (!q.kind || q.kind === 'all' || m.format === (q.kind === 'book' ? 'BOOK' : 'NOVEL')) &&
        (!q.year || m.year === q.year) &&
        (!q.genre || m.genres.some((g) => g.toLowerCase() === q.genre!.toLowerCase())),
    );
  return { ...state, items, page, hasNextPage: data.books.length === limit };
}
export async function hardcoverDetail(id: number): Promise<MediaDetail> {
  const data = await hardcoverQuery<{ books_by_pk: HardcoverBook | null }>(
    `query BunkoBook($id: Int!) { books_by_pk(id: $id) { ${fields} book_series { position series { id name } } editions(limit: 20, order_by: {release_date: desc_nulls_last}) { id title release_date isbn_13 } } }`,
    { id },
    7 * DAY,
  );
  if (!data.books_by_pk) throw new AppError('NOT_FOUND', 'Book not found', 404);
  const row = data.books_by_pk;
  return {
    ...hardcoverMedia(row),
    tags: [
      ...(row.book_series ?? []).map(
        (s) => `${s.series?.name ?? ''}${s.position == null ? '' : ` #${s.position}`}`,
      ),
      ...(row.editions ?? [])
        .filter((e) => e.release_date)
        .map((e) => `${e.title ?? row.title} · ${e.release_date}`),
    ],
    relations: [],
    recommendations: [],
  };
}
