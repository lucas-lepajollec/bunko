import type {
  ChapterRelease,
  DiscoverPage,
  DiscoverQuery,
  MediaDetail,
  UnifiedMedia,
} from '@/types/shared';
import { emptyMedia, cleanSynopsis } from './media';
import { getSettings } from './settings';
import { providerJson, credentialScope } from './catalog-provider-http';
import { AppError } from './errors';
import { publicationDay } from './edition-feeds';
import { releaseNumber } from './release-providers';
import { saveMetadata, storedMetadata } from './metadata-cache';
const DAY = 86400_000;
export interface MetronSeries {
  id: number;
  name?: string;
  series?: string;
  year_began?: number;
  year_end?: number | null;
  issue_count?: number;
  publisher?: { name: string };
  desc?: string;
  image?: string;
  alt_names?: (string | { name: string })[];
  genres?: { name: string }[];
  series_type?: { name: string };
  status?: string;
}
export interface MetronIssue {
  id: number;
  series: MetronSeries;
  number: string;
  store_date?: string | null;
  image?: string;
  desc?: string;
  rating?: { name: string };
}
interface Page<T> {
  results: T[];
  next: string | null;
  count: number;
}
export function metronConfigured() {
  const s = getSettings();
  return Boolean(s.metronApiToken || (s.metronUsername && s.metronPassword));
}
/** Fingerprint only the active mode: a rejected token must never silently fall back to a password. */
export function metronScope(path = '', s = getSettings()) {
  return s.metronApiToken
    ? credentialScope('bearer', s.metronApiToken, path)
    : credentialScope(s.metronUsername, s.metronPassword, path);
}
export function metronJson<T>(path: string, ttl = DAY): Promise<T> {
  const s = getSettings();
  if (!metronConfigured())
    throw new AppError('PROVIDER_UNCONFIGURED', 'Provider is not configured', 409);
  return providerJson(
    'metron',
    metronScope(path, s),
    `https://metron.cloud/api${path}`,
    {
      headers: {
        Authorization: s.metronApiToken
          ? `Bearer ${s.metronApiToken}`
          : `Basic ${Buffer.from(`${s.metronUsername}:${s.metronPassword}`).toString('base64')}`,
      },
    },
    ttl,
    3100,
  );
}
export function metronMedia(row: MetronSeries): UnifiedMedia {
  const name = row.name ?? row.series?.replace(/\s*\(\d{4}\)\s*$/, '') ?? `#${row.id}`;
  const collected = /trade paperback|hardcover|collected|graphic novel|omnibus/i.test(
    row.series_type?.name ?? '',
  );
  return {
    ...emptyMedia(`metron:${row.id}`, name, 'MANGA'),
    providers: ['local'],
    format: 'COMIC',
    altTitles: (row.alt_names ?? []).map((v) => (typeof v === 'string' ? v : v.name)),
    year: row.year_began ?? null,
    startDate: row.year_began ? String(row.year_began) : null,
    chapters: collected ? null : (row.issue_count ?? null),
    volumes: collected ? (row.issue_count ?? null) : null,
    synopsis: cleanSynopsis(row.desc),
    coverUrl: row.image ?? null,
    genres: row.genres?.map((g) => g.name) ?? [],
    status: row.status ?? (row.year_end ? 'completed' : null),
    webUrl: `https://metron.cloud/series/${row.id}/`,
  };
}
function pageMedia(data: Page<MetronSeries>) {
  return data.results.map(metronMedia);
}
export async function discoverComics(q: DiscoverQuery): Promise<DiscoverPage> {
  const page = q.page ?? 1;
  if (!metronConfigured()) return { items: [], page, hasNextPage: false };
  // Metron has no documented popularity ranking. Default is its catalog order; "new" uses the current launch year.
  const params = new URLSearchParams({ page: String(page) });
  if (q.year) params.set('year_began', String(q.year));
  else if (q.sort === 'new') params.set('year_began', String(new Date().getUTCFullYear()));
  if (q.status) params.set('status', q.status === 'FINISHED' ? 'completed' : 'continuing');
  const data = await metronJson<Page<MetronSeries>>(`/series/?${params}`);
  return {
    items: pageMedia(data).filter(
      (m) => !q.genre || m.genres.some((g) => g.toLowerCase() === q.genre!.toLowerCase()),
    ),
    page,
    hasNextPage: Boolean(data.next),
  };
}
export async function searchComics(query: string): Promise<UnifiedMedia[]> {
  if (!metronConfigured()) return [];
  return pageMedia(
    await metronJson<Page<MetronSeries>>(`/series/?${new URLSearchParams({ name: query })}`),
  );
}
export async function metronDetail(id: number): Promise<MediaDetail> {
  const row = await metronJson<MetronSeries>(`/series/${id}/`, 7 * DAY);
  const media = metronMedia(row);
  const issues = await metronJson<Page<MetronIssue>>(`/issue/?series_id=${id}`, 7 * DAY);
  media.coverUrl ??= issues.results.find((r) => r.image)?.image ?? null;
  return {
    ...media,
    tags: [row.publisher?.name, row.year_end ? String(row.year_end) : null].filter(
      (v): v is string => Boolean(v),
    ),
    relations: [],
    recommendations: [],
  };
}
export function metronRelease(row: MetronIssue, series?: MetronSeries): ChapterRelease | null {
  const date = publicationDay(row.store_date ?? '');
  if (!date || !row.series?.id) return null;
  const media = metronMedia({ ...row.series, ...series });
  media.coverUrl = row.image ?? media.coverUrl;
  media.adult = /explicit|adults? only|mature 18/i.test(row.rating?.name ?? '');
  const collected = /trade paperback|hardcover|collected|graphic novel|omnibus/i.test(
    series?.series_type?.name ?? row.series.series_type?.name ?? '',
  );
  const n = releaseNumber(row.number);
  return {
    id: `metron:${row.id}`,
    media,
    chapter: collected ? null : n,
    volume: collected ? n : null,
    unit: collected ? 'volume' : 'chapter',
    label: collected ? `Vol. ${row.number}` : `#${row.number}`,
    group: series?.publisher?.name ?? row.series.publisher?.name ?? null,
    releasedAt: date,
    hasTime: false,
    provider: 'metron',
    trackedId: null,
  };
}
export async function fetchMetronReleases(
  now = new Date(),
  onBatch: (items: ChapterRelease[]) => void = () => {},
): Promise<ChapterRelease[]> {
  if (!metronConfigured()) return [];
  const since = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const until = new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10);
  const items: ChapterRelease[] = [];
  // Bounded weekly range, all pages up to ten; repeated polls use the six-hour durable cache.
  const series = new Map<number, MetronSeries>();
  let lookups = 30;
  for (let page = 1; page <= 10; page++) {
    const data = await metronJson<Page<MetronIssue>>(
      `/issue/?${new URLSearchParams({ store_date_range_after: since, store_date_range_before: until, page: String(page) })}`,
      6 * 3600_000,
    );
    for (const row of data.results) {
      let detail = series.get(row.series.id);
      if (!detail) {
        const path = `/series/${row.series.id}/`;
        const hit = storedMetadata<MetronSeries>(`optional:metron:${metronScope(path)}`);
        if (!hit && lookups-- <= 0) continue;
        detail = await metronJson<MetronSeries>(`/series/${row.series.id}/`, 7 * DAY);
        series.set(detail.id, detail);
      }
      const release = metronRelease(row, detail);
      if (release) {
        items.push(release);
        onBatch([release]);
        saveMetadata(`edition:${release.media.id}`, release.media);
      }
    }
    if (!data.next) break;
  }
  return items;
}
