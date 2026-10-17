import type { ChapterRelease, MediaDetail, UnifiedMedia } from '@/types/shared';
import { emptyMedia, cleanSynopsis } from './media';
import { bookFormat } from './openlibrary';
import { publicFeed } from './public-feed-http';
import { content, nodes, parseXml, values } from './feed-xml';
import { saveMetadata, storedMetadata } from './metadata-cache';
import { getSettings } from './settings';
import { providerJson, credentialScope } from './catalog-provider-http';
import { AppError } from './errors';
const DAY = 86400_000;
export type EditionRelease = ChapterRelease & { isbns?: string[] };
export function isbn(value: string): string | null {
  const n = value
    .replace(/^(?:urn:)?isbn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (!/^(?:\d{13}|\d{9}[\dX])$/.test(n)) return null;
  if (n.length === 10) {
    if ([...n].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11)
      return null;
    const base = `978${n.slice(0, 9)}`;
    return (
      base +
      String((10 - ([...base].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10)
    );
  }
  return [...n].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? n : null;
}
export function publicationDay(value: string): string | null {
  const day = value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  return day && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
    ? day
    : null;
}
export function editionVolume(value: string): number | null {
  const m = value.match(/\b(?:vol(?:ume)?\.?|tome|t\.)\s*(\d+(?:[.,]\d+)?)|\(\s*(\d+)\s*\)\s*$/i);
  return m ? Number((m[1] ?? m[2]).replace(',', '.')) : null;
}
function format(subjects: string[], publisher = ''): UnifiedMedia['format'] {
  const text = subjects.join(' ');
  if (/comics?|graphic novels?|bandes? dessin[ée]es?|\bBD\b/i.test(text)) return 'COMIC';
  if (
    /light novels?|yen press|j-novel|kurokawa.*(?:LN|novel)|seven seas|airship/i.test(
      `${text} ${publisher}`,
    )
  )
    return 'LIGHT_NOVEL';
  return /\bromans?\b/i.test(text) ? 'NOVEL' : bookFormat(subjects);
}
function edition(
  media: UnifiedMedia,
  id: string,
  date: string,
  volume: number | null,
  isbns: string[],
  provider: 'googlebooks' | 'bnf',
): EditionRelease {
  return {
    id,
    media,
    chapter: null,
    volume,
    label: volume === null ? 'Edition' : `${provider === 'bnf' ? 'T.' : 'Vol.'} ${volume}`,
    releasedAt: date,
    hasTime: false,
    unit: 'volume',
    provider,
    trackedId: null,
    group: null,
    isbns,
  };
}
export interface GoogleVolume {
  id: string;
  volumeInfo: {
    title: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    categories?: string[];
    language?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string };
    infoLink?: string;
    seriesInfo?: { volumeSeries?: { orderNumber?: number; seriesId?: string }[] };
  };
}
export function googleEdition(row: GoogleVolume): EditionRelease | null {
  const v = row.volumeInfo;
  if (!v?.title || !/^[\w-]+$/.test(row.id) || !['fr', 'en'].includes(v.language ?? ''))
    return null;
  const day = publicationDay(v.publishedDate ?? '');
  if (!day) return null;
  const f = format(v.categories ?? [], v.publisher);
  const title = [v.title, v.subtitle].filter(Boolean).join(': ');
  const volume = v.seriesInfo?.volumeSeries?.[0]?.orderNumber ?? editionVolume(title);
  const media: UnifiedMedia = {
    ...emptyMedia(`googlebooks:${row.id}`, v.title, f === 'COMIC' ? 'MANGA' : 'NOVEL'),
    format: f,
    providers: ['local'],
    authors: v.authors ?? [],
    genres: v.categories ?? [],
    synopsis: cleanSynopsis(v.description),
    coverUrl: v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null,
    webUrl: `https://books.google.com/books?id=${encodeURIComponent(row.id)}`,
    year: Number(day.slice(0, 4)),
    startDate: day,
    volumes: null,
    adult: /\b(erotica|erotic fiction)\b/i.test((v.categories ?? []).join(' ')),
  };
  return edition(
    media,
    `googlebooks:${row.id}`,
    day,
    volume,
    (v.industryIdentifiers ?? []).flatMap((i) => isbn(i.identifier) ?? []),
    'googlebooks',
  );
}
export function googleBooksJson<T>(url: string, ttl: number): Promise<T> {
  const key = getSettings().googleBooksApiKey;
  if (!key) return publicFeed('googlebooks', url, ttl, JSON.parse);
  const request = new URL(url);
  request.searchParams.set('key', key);
  return providerJson(
    'googlebooks',
    credentialScope(key, url),
    request,
    {},
    Math.min(ttl, 3600_000),
    250,
  );
}
export async function fetchGoogleEditions(
  onBatch?: (items: EditionRelease[]) => void,
): Promise<EditionRelease[]> {
  const failures: unknown[] = [];
  const all: EditionRelease[] = [];
  // Six small requests per six hours at most; exact-date entries only, never invented release days.
  for (const language of ['fr', 'en'])
    for (const subject of ['fiction', 'nonfiction', 'comics']) {
      try {
        const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q: `subject:${subject}`, orderBy: 'newest', langRestrict: language, printType: 'books', maxResults: getSettings().googleBooksApiKey ? '40' : '20' })}`;
        const data = await googleBooksJson<{ items?: GoogleVolume[] }>(url, 6 * 3600_000);
        for (const row of data.items ?? []) {
          const r = googleEdition(row);
          if (r) {
            all.push(r);
            onBatch?.([r]);
            saveMetadata(`edition:${r.media.id}`, r.media);
          }
        }
      } catch (error) {
        failures.push(error);
        /* Other subject/language lanes still contribute, failures are cooled down. */
      }
    }
  if (failures.length && onBatch) throw new AggregateError(failures, 'Edition lanes unavailable');
  return all;
}
export function bnfEditions(xml: string): EditionRelease[] {
  const tree = parseXml(xml);
  if (nodes(tree, 'diagnostic').length) throw new Error('SRU diagnostic');
  return nodes(tree, 'recordData').flatMap((record) => {
    const fields = (tag: string, code: string) =>
      nodes(record, 'datafield')
        .filter((n) => n.attrs.tag === tag)
        .flatMap((n) =>
          n.children.filter((s) => s.name === 'subfield' && s.attrs.code === code).map(content),
        );
    const titles = values(record, 'title');
    const title = titles[0] ?? fields('200', 'a')[0];
    if (!title) return [];
    const date = [...values(record, 'date'), ...fields('210', 'd'), ...fields('214', 'd')]
      .map(publicationDay)
      .find(Boolean);
    if (!date) return [];
    const identifiers = [...values(record, 'identifier'), ...fields('010', 'a')];
    const ark =
      identifiers.join(' ').match(/(?:ark:\/12148\/)?(cb\d+[a-z0-9])/i)?.[1] ??
      nodes(record, 'record')
        .map((n) => n.attrs.id ?? '')
        .join(' ')
        .match(/(cb\d+[a-z0-9])/i)?.[1];
    if (!ark) return [];
    const languages = [...values(record, 'language'), ...fields('101', 'a')];
    if (languages.length && !languages.some((l) => /^(fr|fre|fra)$/i.test(l))) return [];
    const subjects = [
      ...values(record, 'subject'),
      ...values(record, 'type'),
      ...fields('606', 'a'),
      ...fields('608', 'a'),
    ];
    const f = format(subjects);
    const media: UnifiedMedia = {
      ...emptyMedia(`bnf:${ark}`, title.split(/\s*\/\s*/)[0], f === 'COMIC' ? 'MANGA' : 'NOVEL'),
      format: f,
      providers: ['local'],
      authors: [...values(record, 'creator'), ...fields('700', 'a')],
      genres: subjects,
      webUrl: `https://catalogue.bnf.fr/ark:/12148/${ark}`,
      startDate: date,
      year: Number(date.slice(0, 4)),
      adult: /\b(erotica|erotic fiction)\b/i.test(subjects.join(' ')),
    };
    const volume = editionVolume(
      [
        ...titles,
        ...values(record, 'relation'),
        ...fields('200', 'h'),
        ...fields('225', 'v').map((v) => `T. ${v}`),
      ].join(' '),
    );
    return [
      edition(
        media,
        `bnf:${ark}`,
        date,
        volume,
        identifiers.flatMap((i) => isbn(i) ?? []),
        'bnf',
      ),
    ];
  });
}
export async function fetchBnfEditions(now = new Date()): Promise<EditionRelease[]> {
  const since = new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
  const until = now.toISOString().slice(0, 10).replaceAll('-', '');
  // Creation-date selects recently catalogued records; publication year excludes old acquisitions.
  const query = `bib.recordtype any "mon" and bib.doctype any "a" and bib.language any "fre" and bib.publicationdate >= "${now.getUTCFullYear()}" and bib.creationdate within "${since} ${until}" sortBy Dat/sort.descending`;
  const url = `https://catalogue.bnf.fr/api/SRU?${new URLSearchParams({ version: '1.2', operation: 'searchRetrieve', query, recordSchema: 'unimarcxchange', maximumRecords: '50', startRecord: '1' })}`;
  const result = await publicFeed('bnf', url, 12 * 3600_000, (text) => {
    const records = nodes(parseXml(text), 'recordData').length;
    const items = bnfEditions(text);
    saveMetadata('edition-scan:bnf', { records, withPublicationDay: items.length });
    return items;
  });
  for (const r of result) saveMetadata(`edition:${r.media.id}`, r.media);
  return result;
}
export async function editionDetail(id: string): Promise<MediaDetail> {
  let media = storedMetadata<UnifiedMedia>(`edition:${id}`)?.value;
  if (!media && /^googlebooks:[\w-]+$/.test(id)) {
    const row = await googleBooksJson<GoogleVolume>(
      `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id.slice(12))}`,
      7 * DAY,
    );
    media = googleEdition(row)?.media;
  }
  if (!media && /^bnf:cb\d+[a-z0-9]$/i.test(id)) {
    const url = `https://catalogue.bnf.fr/api/SRU?${new URLSearchParams({ version: '1.2', operation: 'searchRetrieve', query: `bib.persistentid any "ark:/12148/${id.slice(4)}"`, recordSchema: 'dublincore', maximumRecords: '1' })}`;
    media = (await publicFeed('bnf', url, 7 * DAY, bnfEditions))[0]?.media;
  }
  if (!media) throw new AppError('NOT_FOUND', 'Edition not found', 404);
  return { ...media, tags: media.genres, relations: [], recommendations: [] };
}
