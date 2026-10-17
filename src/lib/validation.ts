import { z } from 'zod';
import { localImageUrl } from './images';
import type { FilterChange } from '@/types/shared';
const text = z.string().max(20_000);
const id = z.number().int().positive().max(2_147_483_647);
export const sourceId = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine(
    (v) => /^\d{1,19}$/.test(v) && BigInt(v) > 0n && BigInt(v) <= 9223372036854775807n,
    'Source ID must be a positive signed 64-bit decimal string',
  );
export const mediaType = z.enum(['MANGA', 'NOVEL', 'ANIME']);
const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) base URL without credentials, query or fragment');
const resourceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) resource URL without embedded credentials');
const nullableUrl = resourceUrl.nullable();
const imageUrl = z.union([
  resourceUrl,
  z.string().max(2048).refine(localImageUrl, 'Unsupported Bunko image route'),
]);
const sourceImage = imageUrl.nullable();
export const selection = z.object({
  suwayomiMangaId: id,
  sourceId,
  sourceName: z.string().min(1).max(300),
});
export const media = z.object({
  adult: z.boolean().optional(),
  adultOverride: z.boolean().nullable().optional(),
  id: z.string().min(1).max(300),
  type: mediaType,
  title: z.string().min(1).max(500),
  altTitles: z.array(text).max(200),
  anilistId: id.nullable(),
  mangadexId: z.uuid().nullable(),
  mangaUpdatesId: z.string().regex(/^\d+$/).max(30).nullable(),
  coverUrl: imageUrl.nullable(),
  bannerUrl: imageUrl.nullable(),
  synopsis: text.nullable(),
  genres: z.array(text).max(100),
  authors: z.array(text).max(100),
  score: z.number().min(0).max(100).nullable(),
  status: z.string().max(100).nullable(),
  chapters: z.number().nonnegative().nullable(),
  episodes: z.number().nonnegative().nullable(),
  webUrl: nullableUrl,
  providers: z.array(z.enum(['anilist', 'mangadex', 'mangaupdates', 'local', 'kavita'])).max(5),
  sources: z
    .array(
      z.object({
        sourceId,
        sourceName: z.string().max(300),
        suwayomiMangaId: id,
        mangaUrl: z.string().max(2048),
        thumbnailUrl: sourceImage,
        lang: z.string().max(10),
      }),
    )
    .max(100),
  kavita: z
    .object({
      seriesId: id,
      libraryId: id,
      libraryName: z.string().max(500),
      chapters: z.number().int().nonnegative(),
      url: nullableUrl,
    })
    .nullable()
    .default(null),
  trackedId: id.nullable(),
  kavitaSeriesId: id.nullable(),
  format: z
    .enum([
      'MANGA',
      'MANHWA',
      'MANHUA',
      'COMIC',
      'ONE_SHOT',
      'LIGHT_NOVEL',
      'WEB_NOVEL',
      'NOVEL',
      'BOOK',
    ])
    .nullable()
    .default(null),
  origin: z.string().max(8).nullable().default(null),
  year: z.number().int().min(0).max(3000).nullable().default(null),
  volumes: z.number().nonnegative().nullable().default(null),
  editionCount: z.number().int().nonnegative().nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable()
    .default(null),
  popularity: z.number().nonnegative().nullable().default(null),
  startDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable()
    .default(null),
});
export const mediaId = z
  .string()
  .max(80)
  .regex(
    /^(?:anilist|mangadex|mangaupdates|suwayomi|kavita|openlibrary|googlebooks|bnf|metron|hardcover|rakuten):[0-9a-zA-Z_-]+$/,
    'Unknown media identifier',
  );
export const adultOverrideBody = z.object({
  id: z
    .string()
    .max(80)
    .refine((value) => {
      const [provider, key, extra] = value.split(':');
      if (!key || extra !== undefined) return false;
      if (['metron', 'hardcover'].includes(provider)) return /^[1-9]\d{0,9}$/.test(key);
      if (provider === 'rakuten') return /^\d{13}$/.test(key);
      if (provider === 'googlebooks') return /^[\w-]{1,60}$/.test(key);
      if (provider === 'bnf') return /^cb\d+[a-z0-9]$/i.test(key);
      if (provider === 'openlibrary') return /^OL[1-9]\d*W$/.test(key);
      if (provider === 'mangadex') return z.uuid().safeParse(key).success;
      if (provider === 'mangaupdates') return /^[1-9]\d{0,19}$/.test(key);
      if (['anilist', 'suwayomi', 'kavita'].includes(provider))
        return /^[1-9]\d{0,9}$/.test(key) && Number(key) <= 2_147_483_647;
      return false;
    }, 'Unknown media identifier')
    .transform((value) => (value.startsWith('mangadex:') ? value.toLowerCase() : value)),
  adult: z.boolean().nullable(),
});
export const discoverQuery = z
  .object({
    kind: z
      .enum([
        'all',
        'manga',
        'manhwa',
        'manhua',
        'comic',
        'lightnovel',
        'webnovel',
        'novel',
        'book',
      ])
      .optional(),
    sort: z.enum(['trending', 'popular', 'score', 'new']).optional(),
    genre: z.string().max(60).optional(),
    status: z.enum(['RELEASING', 'FINISHED']).optional(),
    season: z.enum(['WINTER', 'SPRING', 'SUMMER', 'FALL']).optional(),
    year: z.coerce.number().int().min(1900).max(2100).optional(),
    page: z.coerce.number().int().min(1).max(200).optional(),
    perPage: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine((q) => !q.season || q.year !== undefined, {
    message: 'Season requires a year',
    path: ['year'],
  });
export const searchParams = z.object({
  q: z.string().trim().min(1).max(200),
  type: mediaType.optional(),
  fast: z.literal('1').optional(),
});
export const settingsPatch = z
  .object({
    mediaRoot: z.string().min(1).max(4096).nullable().optional(),
    suwayomiUrl: httpUrl.optional(),
    suwayomiUsername: z.string().max(300).optional(),
    suwayomiPassword: z.string().max(2000).optional(),
    kavitaUrl: z.union([httpUrl, z.literal('')]).optional(),
    kavitaApiKey: z.string().max(2000).optional(),
    kavitaAuthMode: z.enum(['api-key', 'jwt']).optional(),
    sonarrUrl: z.union([httpUrl, z.literal('')]).optional(),
    sonarrApiKey: z.string().max(2000).optional(),
    prowlarrUrl: z.union([httpUrl, z.literal('')]).optional(),
    prowlarrApiKey: z.string().max(2000).optional(),
    googleBooksApiKey: z
      .string()
      .trim()
      .max(2000)
      .regex(/^[^\s\x00-\x1f]*$/)
      .optional(),
    metronUsername: z
      .string()
      .trim()
      .max(300)
      .regex(/^[^:\x00-\x1f\x7f]*$/)
      .optional(),
    metronPassword: z
      .string()
      .max(2000)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .optional(),
    rakutenApplicationId: z
      .string()
      .trim()
      .max(2000)
      .regex(/^[^\s\x00-\x1f]*$/)
      .optional(),
    rakutenAccessKey: z.string().trim().max(4000).regex(/^[^\s\x00-\x1f\x7f]*$/).optional(),
    hardcoverToken: z
      .string()
      .trim()
      .max(4000)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .optional(),
    kavitaLibraryPath: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (v) =>
          v.startsWith('/') &&
          !v.includes('\\') &&
          !v.includes('\0') &&
          !v.split('/').includes('..'),
        'Use an absolute Kavita container path',
      )
      .optional(),
    autoImportKavita: z.boolean().optional(),
    adultContent: z.boolean().optional(),
    libraryTargets: z
      .object(
        Object.fromEntries(
          ['MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'LIGHT_NOVEL', 'WEB_NOVEL', 'NOVEL', 'BOOK'].map(
            (kind) => [
              kind,
              z
                .object({
                  libraryId: id,
                  folder: z
                    .string()
                    .min(1)
                    .max(2048)
                    .refine(
                      (v) =>
                        v.startsWith('/') &&
                        !v.includes('\\') &&
                        !v.includes('\0') &&
                        !v.split('/').includes('..'),
                      'Use an absolute Kavita folder',
                    ),
                })
                .strict()
                .nullable()
                .optional(),
            ],
          ),
        ),
      )
      .strict()
      .optional(),
    favoriteSourceIds: z.array(sourceId).max(100).optional(),
    extensionRepos: z.array(httpUrl).max(20).optional(),
    updateIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  })
  .strict();
export const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refresh') }),
  z.object({ action: z.literal('update_all') }),
  ...(['install', 'update', 'uninstall'] as const).map((a) =>
    z.object({ action: z.literal(a), id: z.string().min(1).max(300) }),
  ),
]);
export const enqueueBody = z.object({ chapterIds: z.array(id).min(1).max(500), media });
export const releaseQuery = z.object({
  provider: z.enum(['sonarr', 'prowlarr']).optional(),
  query: z.string().trim().min(1).max(300).optional(),
  seriesId: z.coerce.number().int().positive().optional(),
  seasonNumber: z.coerce.number().int().nonnegative().optional(),
  episodeNumber: z.coerce.number().int().positive().optional(),
});
export const grabBody = z.object({
  provider: z.enum(['sonarr', 'prowlarr']),
  guid: z.string().min(1).max(4096),
  indexerId: id,
});
export const readingStatus = z.enum(['PLANNING', 'READING', 'PAUSED', 'COMPLETED', 'DROPPED']);
export const trackBody = z
  .object({
    media,
    status: readingStatus.optional(),
    autoDownload: z.boolean().optional(),
    kavitaSeriesId: id.nullable().optional(),
    sources: z.array(selection).max(20).optional(),
  })
  .refine(
    (v) => !v.autoDownload || (v.sources?.length && v.media.type !== 'ANIME'),
    'Automatic downloads require manga/novel sources',
  );
export const trackPatch = z
  .object({
    id,
    media: media.optional(),
    unit: z.enum(['chapter', 'volume']).optional(),
    displayTitle: z.string().trim().min(1).max(300).nullable().optional(),
    offCatalog: z.literal(true).optional(),
    backdrop: z.enum(['auto', 'hidden']).optional(),
    cover: z
      .union([
        z.literal('auto'),
        z
          .object({
            origin: z.enum(['catalog', 'source', 'kavita']),
            id: z.string().min(1).max(300),
          })
          .strict(),
      ])
      .optional(),
    status: readingStatus.optional(),
    autoDownload: z.boolean().optional(),
    kavitaSeriesId: id.nullable().optional(),
    sources: z.array(selection).max(20).optional(),
  })
  .refine((v) => !(v.media && v.offCatalog), 'Choose a catalog identity or detach it');

export const sourcePreferences = z
  .object({
    enabledSourceIds: z
      .array(sourceId)
      .max(500)
      .refine((v) => new Set(v).size === v.length, 'Duplicate source IDs'),
    languages: z
      .array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/))
      .min(1)
      .max(50),
  })
  .strict();
// Bound recursion as well as body bytes so malicious nested groups cannot overflow the stack.
function filterChangeSchema(depth: number): z.ZodType<FilterChange> {
  return z
    .object({
      position: z.number().int().min(0).max(1000),
      selectState: z.number().int().min(0).max(10000).optional(),
      textState: z.string().max(2000).optional(),
      checkBoxState: z.boolean().optional(),
      triState: z.enum(['IGNORE', 'INCLUDE', 'EXCLUDE']).optional(),
      sortState: z
        .object({ index: z.number().int().min(0).max(10000), ascending: z.boolean() })
        .strict()
        .optional(),
      groupChange:
        depth > 0 ? z.lazy(() => filterChangeSchema(depth - 1)).optional() : z.never().optional(),
    })
    .strict()
    .refine(
      (v) => Object.keys(v).filter((k) => k !== 'position').length === 1,
      'Supply exactly one filter state',
    );
}
export const browseBody = z
  .object({
    mode: z.enum(['POPULAR', 'LATEST', 'SEARCH']),
    query: z.string().max(200).optional(),
    page: z.number().int().min(1).max(10000),
    filters: z.array(filterChangeSchema(8)).max(100).optional(),
  })
  .strict();
export const downloadControl = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['pause', 'resume', 'clear']) }).strict(),
  z.object({ action: z.literal('retry_failed'), batchId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('remove'), batchId: z.uuid() }).strict(),
]);
