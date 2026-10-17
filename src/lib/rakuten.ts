import type { MediaDetail, UnifiedMedia } from '@/types/shared';
import { emptyMedia, cleanSynopsis } from './media';
import { getSettings } from './settings';
import { providerJson, credentialScope } from './catalog-provider-http';
import { AppError } from './errors';
import { editionVolume, isbn, publicationDay, type EditionRelease } from './edition-feeds';
import { saveMetadata, storedMetadata } from './metadata-cache';
export interface RakutenBook {
  title: string;
  subTitle?: string;
  author?: string;
  publisherName?: string;
  isbn: string;
  salesDate?: string;
  booksGenreId?: string;
  largeImageUrl?: string;
  itemUrl?: string;
  itemCaption?: string;
}
/** Approximate Japanese dates retain their precision; they never acquire an invented calendar day. */
export function rakutenDate(value: string): string | null {
  const exact = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (exact)
    return publicationDay(`${exact[1]}-${exact[2].padStart(2, '0')}-${exact[3].padStart(2, '0')}`);
  const month = value.match(/^(\d{4})年(\d{1,2})月(?:上旬|中旬|下旬|頃|以降)?$/);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12)
    return `${month[1]}-${month[2].padStart(2, '0')}`;
  return /^\d{4}年$/.test(value) ? value.slice(0, 4) : null;
}
export function rakutenMedia(
  row: RakutenBook,
  kind: 'lightnovel' | 'manga' = 'lightnovel',
): UnifiedMedia {
  const date = rakutenDate(row.salesDate ?? '');
  return {
    ...emptyMedia(`rakuten:${row.isbn}`, row.title, kind === 'manga' ? 'MANGA' : 'NOVEL'),
    providers: ['local'],
    format: kind === 'manga' ? 'MANGA' : 'LIGHT_NOVEL',
    origin: 'JP',
    authors:
      row.author
        ?.split('/')
        .map((v) => v.trim())
        .filter(Boolean) ?? [],
    synopsis: cleanSynopsis(row.itemCaption),
    coverUrl: row.largeImageUrl ?? null,
    webUrl: row.itemUrl ?? null,
    startDate: date,
    year: date ? Number(date.slice(0, 4)) : null,
  };
}
export function rakutenEdition(
  row: RakutenBook,
  kind: 'lightnovel' | 'manga' = 'lightnovel',
): EditionRelease | null {
  const media = rakutenMedia(row, kind);
  if (!/^\d{13}$/.test(row.isbn) || media.startDate?.length !== 10) return null;
  const volume = editionVolume(row.title.replaceAll('（', '(').replaceAll('）', ')'));
  return {
    id: `rakuten:${row.isbn}`,
    media,
    chapter: null,
    volume,
    unit: 'volume',
    label: volume === null ? row.title : `Vol. ${volume}`,
    provider: 'rakuten',
    releasedAt: media.startDate,
    hasTime: false,
    group: `Japon / Japan${row.publisherName ? ` · ${row.publisherName}` : ''}`,
    trackedId: null,
    isbns: isbn(row.isbn) ? [isbn(row.isbn)!] : [],
  };
}
/** Current RWS requires both values. Never try the retired applicationId-only endpoint. */
export function rakutenJson<T>(params: Record<string, string>, accessKey?: string): Promise<T> {
  const settings = getSettings();
  const applicationId = settings.rakutenApplicationId;
  accessKey ??= settings.rakutenAccessKey;
  if (!applicationId)
    throw new AppError('PROVIDER_UNCONFIGURED', 'Provider is not configured', 409);
  if (!accessKey)
    throw new AppError('PROVIDER_ACCESS_KEY_REQUIRED', 'Provider requires an access key', 409);
  const url = new URL('https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404');
  url.search = new URLSearchParams({ ...params, applicationId, format: 'json' }).toString();
  return providerJson(
    'rakuten',
    credentialScope(applicationId, accessKey, JSON.stringify(params)),
    url,
    { headers: { accessKey } },
    6 * 3600_000,
    1200,
  );
}
export async function fetchRakutenReleases(accessKey?: string): Promise<EditionRelease[]> {
  if (!getSettings().rakutenApplicationId) return [];
  const all: EditionRelease[] = [];
  for (const [kind, genre] of [
    ['lightnovel', '001017'],
    ['manga', '001001'],
  ] as const) {
    const data = await rakutenJson<{ Items: { Item: RakutenBook }[] }>(
      { booksGenreId: genre, sort: '-releaseDate', hits: '30', page: '1' },
      accessKey,
    );
    for (const { Item: row } of data.Items) {
      const media = rakutenMedia(row, kind);
      saveMetadata(`edition:${media.id}`, media);
      const release = rakutenEdition(row, kind);
      if (release) all.push(release);
    }
  }
  return all;
}
export function rakutenDetail(id: string): MediaDetail {
  const media = storedMetadata<UnifiedMedia>(`edition:${id}`)?.value;
  if (!media) throw new AppError('NOT_FOUND', 'Edition not found', 404);
  return { ...media, tags: [], relations: [], recommendations: [] };
}
