/** Browser-safe API contract. No database/server imports in this file. */
export type MediaType = 'MANGA' | 'NOVEL' | 'ANIME';
/** `kavita` = a series known only from Kavita (no catalog match). */
export type Provider = 'anilist' | 'mangadex' | 'mangaupdates' | 'local' | 'kavita';
/** Reading format derived from provider format and country of origin. */
export type MediaFormat =
  | 'MANGA'
  | 'MANHWA'
  | 'MANHUA'
  | 'ONE_SHOT'
  | 'LIGHT_NOVEL'
  | 'WEB_NOVEL'
  /** Western comics / BD, with optional Metron discovery plus sources and Kavita. */
  | 'COMIC'
  /** Novel (fiction book: "roman"), distinct from LN/WN. */
  | 'NOVEL'
  /** Non-fiction book ("livre": essays, history, science, manuals…). */
  | 'BOOK';
export interface SourceMatch {
  sourceId: string;
  sourceName: string;
  suwayomiMangaId: number;
  mangaUrl: string;
  thumbnailUrl: string | null;
  lang: string;
}
export interface UnifiedMedia {
  id: string;
  type: MediaType;
  title: string;
  altTitles: string[];
  anilistId: number | null;
  mangadexId: string | null;
  mangaUpdatesId: string | null;
  coverUrl: string | null;
  bannerUrl: string | null;
  synopsis: string | null;
  genres: string[];
  authors: string[];
  score: number | null;
  status: string | null;
  chapters: number | null;
  episodes: number | null;
  webUrl: string | null;
  providers: Provider[];
  sources: SourceMatch[];
  trackedId: number | null;
  kavitaSeriesId: number | null;
  format: MediaFormat | null;
  /** ISO country of origin (JP, KR, CN, TW...). */
  origin: string | null;
  year: number | null;
  volumes: number | null;
  /** Dominant cover colour supplied by AniList, used as a per-title accent. */
  color: string | null;
  popularity: number | null;
  /** Publication start as a partial ISO date: "YYYY", "YYYY-MM" or "YYYY-MM-DD". */
  startDate: string | null;
  /** The matching series already present in Kavita, if any. */
  kavita: KavitaPresence | null;
  /**
   * Adult (18+) content: AniList isAdult, MangaDex erotica/pornographic, MangaUpdates
   * Adult/Hentai/Smut genres, or only found on NSFW sources. Hidden everywhere unless enabled.
   */
  adult?: boolean;
  /** The user's own 18+ decision for this work (`null` = follow the automatic classification). */
  adultOverride?: boolean | null;
}
export interface KavitaPresence {
  seriesId: number;
  libraryId: number;
  libraryName: string;
  /** Distinct chapter numbers Kavita holds for the series. */
  chapters: number;
  /** Deep link into the Kavita web reader, when the Kavita address is known. */
  url: string | null;
}
export interface RelatedMedia {
  relation: string;
  media: UnifiedMedia;
}
export interface LoadState {
  /** Data is still being enriched/refreshed. Existing items may be used but are not final. */
  pending?: boolean;
  /** One or more upstream refreshes failed; retained items may be incomplete. */
  partial?: boolean;
}
export interface MediaDetail extends UnifiedMedia, LoadState {
  tags: string[];
  relations: RelatedMedia[];
  recommendations: UnifiedMedia[];
}
/** `novel` = romans (fiction books), `book` = livres (non-fiction); LN and WN are separate. */
export type DiscoverKind =
  'all' | 'manga' | 'manhwa' | 'manhua' | 'comic' | 'lightnovel' | 'webnovel' | 'novel' | 'book';
/** "new" = most recent publication start first, never future or undated titles. */
export type DiscoverSort = 'trending' | 'popular' | 'score' | 'new';
/** Quarter-based seasons, AniList convention: WINTER Jan–Mar, SPRING Apr–Jun, SUMMER Jul–Sep, FALL Oct–Dec. */
export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export interface DiscoverQuery {
  kind?: DiscoverKind;
  sort?: DiscoverSort;
  genre?: string;
  status?: 'RELEASING' | 'FINISHED';
  /** Restrict to titles whose publication started in this season (requires `year`). */
  season?: Season;
  /** Restrict to titles whose publication started in this year (alone or with `season`). */
  year?: number;
  page?: number;
  perPage?: number;
}
/* ---- Releases feed, weekly planning, home (contract for /api/releases, /api/planning, /api/home) ---- */
/** One chapter release, newest first in feeds. */
export interface ChapterRelease {
  /** Stable id (`<provider>:<release id>`). */
  id: string;
  /** The series, resolved to a catalog work when possible (link with `mediaHref(media.id)`). */
  media: UnifiedMedia;
  chapter: number | null;
  volume: number | null;
  /** Display label as published, e.g. "c.1130" or "v.3 c.12-14". */
  label: string;
  /** Scanlation group(s), when known. */
  group: string | null;
  /** When the release was published; `hasTime` false when only the day is known. */
  releasedAt: string;
  hasTime: boolean;
  provider:
    | 'mangaupdates'
    | 'mangadex'
    | 'source'
    | 'googlebooks'
    | 'bnf'
    | 'royalroad'
    | 'metron'
    | 'rakuten';
  /** `volume` = a new tome/edition (books, LN volumes, BD albums); otherwise a chapter. */
  unit?: 'chapter' | 'volume';
  /** Followed title in the library, if any. */
  trackedId: number | null;
}
/** GET /api/releases?kind=&genre=&library=1&cursor= */
export interface ReleasesPage extends LoadState {
  items: ChapterRelease[];
  /** Opaque cursor for "load more"; null at the end. */
  nextCursor: string | null;
}
/** GET /api/planning?week=YYYY-MM-DD (any day of the week; default current week)&kind=&library=1 */
export interface PlanningWeek extends LoadState {
  /** Monday of the week (ISO date) in the server's time zone. */
  start: string;
  days: PlanningDay[];
}
export interface PlanningDay {
  date: string;
  items: PlanningItem[];
}
export interface PlanningItem {
  media: UnifiedMedia;
  /** `released`: actually published that day; `expected`: usual release day estimated from history. */
  kind: 'released' | 'expected';
  chapter: number | null;
  /** Local time "HH:MM" when known (released with a timestamp, or a regular expected hour), else null. */
  time: string | null;
  trackedId: number | null;
}
/** GET /api/home */
export interface HomeFeed extends LoadState {
  /** Latest releases for the hero carousel (with artwork). */
  hero: ChapterRelease[];
  /** Weekly trending top 10, all formats. */
  top: UnifiedMedia[];
  /** Latest chapter releases per format (≤ 12 each). */
  latest: Record<Exclude<DiscoverKind, 'all'>, ChapterRelease[]>;
}
export interface DiscoverPage {
  items: UnifiedMedia[];
  page: number;
  hasNextPage: boolean;
  /** More provider results/classification are loading; revalidate this page until false. */
  pending?: boolean;
  /** Partial upstream failure; available items remain usable. */
  warnings?: { provider: string; code: 'METADATA_UNAVAILABLE' }[];
}
/** A title found on a Suwayomi source, scored against the requested media (0..1). */
export interface SourceCandidate extends SourceMatch {
  title: string;
  score: number;
  /** Chapters available; browser suggestions prefer interface language after relevance, then completeness. */
  chapterCount?: number | null;
}
export type MatchEventMap = {
  linked: { trackedId: number };
  sources: { sources: Source[] };
  match: { source: Source; candidates: SourceCandidate[]; durationMs: number };
  source_error: { source: Source; code: string; detail?: string | null };
  done: { completed: number };
  error: ApiError['error'];
};
export interface ProviderOutcome {
  provider: Provider;
  status: 'ok' | 'error';
  durationMs: number;
}
export interface SearchResponse extends LoadState {
  results: UnifiedMedia[];
  providers: ProviderOutcome[];
  durationMs: number;
  /**
   * `GET /api/search?q=&fast=1` answers within ~300 ms from the local catalog and cached
   * provider results with `partial: true`; the UI then asks for the full answer.
   */
  partial?: boolean;
}
export interface Source {
  id: string;
  name: string;
  lang: string;
  /** Extension flagged NSFW by Suwayomi; skipped unless adult content is enabled. */
  nsfw?: boolean;
}
export interface SourceResult {
  source: Source;
  results: SourceMatch[];
  titles: string[];
  hasNextPage: boolean;
  durationMs: number;
}
export interface Extension {
  id: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  iconUrl: string;
}
export type ExtensionAction =
  | { action: 'refresh' }
  | { action: 'update_all' }
  | { action: 'install' | 'update' | 'uninstall'; id: string };
export interface ChapterVariant {
  id: number;
  mangaId: number;
  sourceId: string;
  sourceName: string;
  name: string;
  number: number | null;
  scanlator: string | null;
  isDownloaded: boolean;
  /** Volume (tome) from the source or parsed from the chapter name, when known. */
  volume: number | null;
}
export interface MergedChapter {
  key: string;
  number: number | null;
  /** Volume shared by the variants when known (first variant with one wins). */
  volume: number | null;
  variants: ChapterVariant[];
  /**
   * Chapter present in the library files (Kavita/imported) but on no linked source; `variants` is
   * empty and it opens in the reader with `/api/reader/chapter?local=<number>&media=<id>`.
   */
  localOnly?: boolean;
}

/* ---- Built-in reader (contract for /api/reader/*) ---- */
/** GET /api/reader/chapter?id=<suwayomi chapter id>&media=<media id, optional> */
export interface ReaderChapter {
  unit?: 'chapter' | 'volume';
  chapterId: number;
  mangaId: number;
  sourceName: string;
  /** "Chapter 12", "Vol. 3 Ch. 12" or the source's name. */
  label: string;
  number: number | null;
  volume: number | null;
  /** Page image URLs in order (`/api/reader/page?chapter=&index=`), cached by Bunko. */
  pages: string[];
  /** Current source-lane neighbours, merged with owned stock independently of cached pages. */
  prevId: number | null;
  nextId: number | null;
  /** Suggested layout from the work's format (manhwa/manhua → vertical, manga → rtl, comic → ltr). */
  direction: 'rtl' | 'ltr' | 'vertical';
  /** Saved position for this chapter (0-based page), if any. */
  resumePage: number | null;
  /** Set for chapters read from library files only (no source chapter id). */
  local?: number;
  /** Owned neighbours by number, including older Kavita files and imports from other sources. */
  prevLocal?: number | null;
  nextLocal?: number | null;
}
/** PUT /api/reader/progress — finishing advances the verified chapter or local-volume unit. */
export interface ReaderProgressUpdate {
  mediaId: string;
  chapterId: number;
  number: number | null;
  page: number;
  pageCount: number;
}
export interface ChaptersResponse extends LoadState {
  ownedVolumes?: number[];
  chapters: MergedChapter[];
  errors: { mangaId: number; code: string }[];
  /** Chapter numbers already in the matching Kavita series (empty when none is known). */
  inKavita: number[];
}
export interface ChapterSelection {
  suwayomiMangaId: number;
  sourceId: string;
  sourceName: string;
}
export interface DownloadItem {
  state: string;
  progress: number;
  tries: number;
  position: number;
  chapter: { id: number; name: string; chapterNumber: number };
  manga: { id: number; title: string };
}
export interface DownloadStatus {
  state: string;
  queue: DownloadItem[];
}
export interface EnqueueRequest {
  chapterIds: number[];
  media: UnifiedMedia;
}
export interface DownloadBatch {
  id: string;
  /** Internal connection identity; older batches are bound during migration. */
  sourceKey?: string;
  media: UnifiedMedia;
  chapterIds: number[];
  importedIds: number[];
  state: 'enqueuing' | 'downloading' | 'importing' | 'scanning' | 'completed' | 'error';
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Every chapter of the batch, in queue order, with its own state. */
  chapters: DownloadChapter[];
  /** Kavita rescan after import: `null` until attempted. */
  scan: { state: 'done' | 'failed'; error: string | null; at: string } | null;
}
export interface DownloadChapter {
  /** Suwayomi chapter id (same as in `chapterIds`). */
  id: number;
  number: number | null;
  /** Display name from the source, e.g. "Chapter 96" or "Vol. 3 Ch. 12". */
  name: string;
  sourceName: string;
  state: 'queued' | 'downloading' | 'importing' | 'done' | 'error';
  /** 0–1 while pages download, otherwise null. */
  progress: number | null;
  /** Safe error code (translated by the UI) when `state` is `error`. */
  error: string | null;
}
export interface DownloadsSnapshot {
  status: DownloadStatus;
  batches: DownloadBatch[];
}
export interface Release {
  provider: 'sonarr' | 'prowlarr';
  guid: string;
  indexerId: number;
  title: string;
  indexer: string;
  sizeBytes: number;
  sizeGb: number;
  seeders: number | null;
  languages: string[];
  resolution: string | null;
  codec: string | null;
  protocol: string;
  rejected: boolean;
  rejections: string[];
  publishDate: string | null;
}
export interface ReleaseQuery {
  query?: string;
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  provider?: 'sonarr' | 'prowlarr';
}
export interface GrabReleaseRequest {
  provider: 'sonarr' | 'prowlarr';
  guid: string;
  indexerId: number;
}
export interface Settings {
  suwayomiUrl: string;
  suwayomiUsername: string;
  suwayomiPassword: string;
  kavitaUrl: string;
  kavitaApiKey: string;
  kavitaAuthMode: 'api-key' | 'jwt';
  sonarrUrl: string;
  sonarrApiKey: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  /** Kavita-side path of the folder mounted at /library in this container. */
  kavitaLibraryPath: string;
  /** Kavita library and folder receiving each format; unset kinds use the suggested library. */
  libraryTargets: LibraryTargets;
  /** Follow every Kavita series automatically (matched to the catalog when possible). Default true. */
  autoImportKavita: boolean;
  /** Shared optional catalog credentials, managed by admins; empty = unused or keyless mode. */
  googleBooksApiKey: string;
  metronApiToken: string;
  metronUsername: string;
  metronPassword: string;
  rakutenApplicationId: string;
  rakutenAccessKey: string;
  hardcoverToken: string;
  /**
   * This account's media folder: `/library` or one of its direct subfolders (any name). Exclusive
   * per account; never nested in another account's folder. Null = not chosen.
   */
  mediaRoot: string | null;
  /**
   * @deprecated Per user since multi-user: reads/writes the signed-in user's preference
   * (see `MyAccount.adultContent`).
   */
  adultContent: boolean;
  favoriteSourceIds: string[];
  extensionRepos: string[];
  /** Worker update-check interval in minutes (5–1440), default 15. */
  updateIntervalMinutes: number;
}
export type SecretSetting =
  | 'suwayomiPassword'
  | 'kavitaApiKey'
  | 'sonarrApiKey'
  | 'prowlarrApiKey'
  | 'googleBooksApiKey'
  | 'metronApiToken'
  | 'metronPassword'
  | 'rakutenApplicationId'
  | 'rakutenAccessKey'
  | 'hardcoverToken';
export type PublicSettings = Omit<Settings, SecretSetting> & {
  secretsConfigured: Record<SecretSetting, boolean>;
  /** Shared availability is visible to members; credential changes/probes require an admin. */
  catalogs: { canManage: boolean; configured: Record<CatalogProvider, boolean> };
};
export type CatalogProvider = 'googlebooks' | 'metron' | 'rakuten' | 'hardcover';
export const catalogSettingKeys = [
  'googleBooksApiKey',
  'metronApiToken',
  'metronUsername',
  'metronPassword',
  'rakutenApplicationId',
  'rakutenAccessKey',
  'hardcoverToken',
] as const satisfies readonly (keyof Settings)[];
export type CatalogSetting = (typeof catalogSettingKeys)[number];
export type SettingsPatch = Partial<Settings>;
export interface TrackedMedia {
  id: number;
  anilistId: number | null;
  mangadexId: string | null;
  title: string;
  type: MediaType;
  coverUrl: string | null;
  kavitaSeriesId: number | null;
  autoDownload: boolean;
  createdAt: string;
  media: UnifiedMedia;
  /** Ordered by priority: index 0 is preferred for downloads. */
  sources: ChapterSelection[];
  status: ReadingStatus;
  progress: LibraryProgress;
  /** Chapters detected on sources and not yet in the library. */
  newChapters: number;
  lastReadAt: string | null;
  /** One entry per linked source, same order as `sources`, refreshed in the background. */
  sourceStatus: SourceLinkStatus[];
  /** Names this work is known by (catalog title, alternative titles, Kavita series name), for picking `displayTitle`. */
  titleOptions?: string[];
  /** True when `title` comes from the user's choice. */
  customTitle?: boolean;
  /**
   * How this work is counted (user choice, default `chapter`). With `volume`, `progress`
   * (read/owned/released/unread) and `newChapters` are in volumes (from Kavita volumes, catalog
   * volume counts and source volume numbers).
   */
  unit?: 'chapter' | 'volume';
  /** Current owned inventory was explicitly declared as volumes by the user. */
  ownedAsVolumes?: boolean;
  /** Owned chapter count, independent of the chosen display unit. */
  ownedChapterCount?: number;
  /** Verified complete volumes, including the user's current-inventory declaration. */
  ownedVolumes?: number[];
  /** Reading position in chapters, independent of the displayed progress unit. */
  chapterRead?: number | null;
  volumeRead?: number | null;
  /** Last position in the built-in reader, for "Resume". */
  readerPosition?: {
    chapterId: number;
    number: number | null;
    page: number;
    updatedAt: string;
  } | null;
  /** Where the displayed cover comes from; `auto` = best available (catalog, then sources, then Kavita). */
  coverChoice: CoverChoice;
  /** Identity of the entry: a catalog work, or off-catalog (known only from Kavita or a source). */
  identity: 'catalog' | 'off-catalog';
  /** Other covers to try, in automatic order, when `coverUrl` fails to load (empty for a manual choice). */
  coverFallbacks: string[];
  /** Bunko's cover is pushed to Kavita for this work (user choice, default true). */
  kavitaCoverSync?: boolean;
  /** Whether the displayed cover reached Kavita (upload needs an admin API key). */
  kavitaCover: { state: 'synced' | 'pending' | 'failed' | 'none'; error: string | null };
  /** Hero background: the catalog work's banner (`auto`) or none (`hidden`, chosen by the user). */
  backdrop: 'auto' | 'hidden';
  /** Background source matching for this entry (comics only; `linked` once it has sources). */
  sourceMatch: 'linked' | 'queued' | 'searching' | 'not-found';
}
/** GET /api/library/activity — what Bunko is doing in the background, for progress indicators. */
export interface LibraryActivity {
  /** Tenant library revision; clients invalidate stale sheets/lists when background writes land. */
  revision?: number;
  /** Separate durable domains avoid reloading source lists after page turns or release ingestion. */
  revisions?: { content: number; progress: number; releases: number };
  activeDownloads?: number;
  /** Followed titles currently hidden because 18+ content is off (never hidden silently). */
  hiddenAdult: number;
  /** Followed comics waiting for automatic source matching, and the one being searched now. */
  matching: { queued: number; current: string | null };
  /** Release refresh across linked sources (latest chapters, thumbnails). */
  refresh: {
    running: boolean;
    done: number;
    total: number;
    lastAt: string | null;
    nextAt: string | null;
  };
}
export interface SourceLinkStatus {
  sourceId: string;
  suwayomiMangaId: number;
  /** Title of the entry on that source. */
  title: string;
  thumbnailUrl: string | null;
  /** Highest numbered chapter on that source at the last check. */
  latestChapter: number | null;
  chapterCount: number | null;
  checkedAt: string | null;
  /** Linked automatically (by background matching) rather than chosen by the user. */
  auto: boolean;
  /** Safe error code of the last check, if it failed. */
  error: string | null;
}
export type CoverChoice = 'auto' | { origin: 'catalog' | 'source' | 'kavita'; id: string };
/** GET /api/tracked/covers?id= — every cover that can be chosen for a followed title. */
export interface CoverOption {
  origin: 'catalog' | 'source' | 'kavita';
  /** Stable id to send back in `TrackPatch.cover`. */
  id: string;
  /** Short label: provider, source name or volume. */
  label: string;
  /** Displayable URL (proxied when needed). */
  url: string;
}
/** User reading state. "Caught up" is derived (READING and nothing unread), never stored. */
export type ReadingStatus = 'PLANNING' | 'READING' | 'PAUSED' | 'COMPLETED' | 'DROPPED';
export interface LibraryProgress {
  /** Highest chapter number read, from Kavita reading progress when available. */
  read: number | null;
  /** Owned chapters, or explicitly indexed complete volumes when the work uses volume units. */
  owned: number;
  /** Highest chapter number known on metadata or sources. */
  released: number | null;
  /** Owned chapters above `read`. */
  unread: number;
  /** Where `read` comes from. */
  readSource: 'kavita' | 'none';
}
export interface TrackPatch {
  id: number;
  /** Replace a wrong catalog match; status, sources and history are kept. */
  media?: UnifiedMedia;
  /** Title shown in Bunko for this work (any string; `null` = the catalog/Kavita title). */
  displayTitle?: string | null;
  /** Count this work in volumes (tomes) or chapters. */
  unit?: 'chapter' | 'volume';
  /** Explicitly reinterpret currently owned numbered files as complete tomes; false restores detection. */
  ownedAsVolumes?: boolean;
  /** Push Bunko's cover for this work to Kavita (default true). */
  kavitaCoverSync?: boolean;
  /** Show the catalog banner behind the title (`auto`) or hide it (`hidden`). */
  backdrop?: 'auto' | 'hidden';
  /** Detach from the catalog (wrong match, title not catalogued): identity becomes the Kavita series or the first source. */
  offCatalog?: true;
  /**
   * Pick a cover (`CoverOption.id` with its origin) or go back to automatic. A `source` id is
   * `<sourceId>:<suwayomiMangaId>` and may name any Suwayomi entry, linked or not (e.g. a scan result).
   */
  cover?: CoverChoice;
  status?: ReadingStatus;
  autoDownload?: boolean;
  kavitaSeriesId?: number | null;
  sources?: ChapterSelection[];
}
export interface TrackRequest {
  media: UnifiedMedia;
  status?: ReadingStatus;
  autoDownload?: boolean;
  kavitaSeriesId?: number | null;
  sources?: ChapterSelection[];
}
export interface ApiError {
  error: { code: string; message: string };
}
export type SearchEventMap = {
  sources: { sources: Source[] };
  source_result: SourceResult;
  source_error: { source: Source; code: string; detail?: string | null };
  done: { completed: number };
  error: ApiError['error'];
};
export type DownloadEventMap = { snapshot: DownloadsSnapshot; error: ApiError['error'] };
export type ServiceState = 'ok' | 'error' | 'unconfigured';
export interface ServicesStatus {
  suwayomi: { state: ServiceState; version: string | null };
  kavita: {
    state: ServiceState;
    /** The API key belongs to a Kavita admin (needed for scans and cover uploads); null if unknown. */
    admin: boolean | null;
  };
}

/* ---- Sources, browsing and updates (contract for /api/sources/*, /api/updates, /api/downloads/control) ---- */
export interface SourceHealth {
  state: 'ok' | 'slow' | 'error' | 'unknown';
  latencyMs: number | null;
  /** Safe error code only (e.g. UPSTREAM_TIMEOUT, CLOUDFLARE, SOURCE_HTTP_ERROR, SOURCE_LOGIN_REQUIRED). */
  error: string | null;
  /** Short, sanitized reason reported by the extension (no URLs, no credentials), for display. */
  detail?: string | null;
  checkedAt: string | null;
}
export interface SourceInfo extends Source {
  iconUrl: string | null;
  /** Included in global live search. */
  enabled: boolean;
  /** Position in the global search order (0 first), null when disabled. */
  priority: number | null;
  health: SourceHealth;
  /** Package of the extension providing the source, when known. */
  extensionId: string | null;
}
export interface SourcePreferences {
  /** Ordered list of source ids searched globally; empty means every installed source of the user's languages. */
  enabledSourceIds: string[];
  /** Allowed source languages (ISO codes); foreground search favors the active interface language within this list. */
  languages: string[];
}
/** Mirrors Suwayomi source filters, flattened for rendering. `position` is the index in the source filter list. */
export type SourceFilter =
  | { kind: 'header' | 'separator'; position: number; name: string }
  | { kind: 'select'; position: number; name: string; values: string[]; default: number }
  | { kind: 'text'; position: number; name: string; default: string }
  | { kind: 'checkbox'; position: number; name: string; default: boolean }
  | { kind: 'tristate'; position: number; name: string; default: 'IGNORE' | 'INCLUDE' | 'EXCLUDE' }
  | {
      kind: 'sort';
      position: number;
      name: string;
      values: string[];
      default: { index: number; ascending: boolean } | null;
    }
  | { kind: 'group'; position: number; name: string; filters: SourceFilter[] };
/** Mirrors Suwayomi FilterChangeInput. */
export interface FilterChange {
  position: number;
  selectState?: number;
  textState?: string;
  checkBoxState?: boolean;
  triState?: 'IGNORE' | 'INCLUDE' | 'EXCLUDE';
  sortState?: { index: number; ascending: boolean };
  groupChange?: FilterChange;
}
export interface BrowseRequest {
  mode: 'POPULAR' | 'LATEST' | 'SEARCH';
  query?: string;
  page: number;
  filters?: FilterChange[];
}
export interface BrowseItem extends SourceMatch {
  title: string;
  /** Linked to a tracked library entry. */
  trackedId: number | null;
}
export interface BrowsePage {
  source: SourceInfo;
  items: BrowseItem[];
  page: number;
  hasNextPage: boolean;
}
export type UpdateState = 'pending' | 'queued' | 'downloading' | 'downloaded' | 'error';
export interface UpdateEntry {
  id: number;
  trackedId: number;
  title: string;
  coverUrl: string | null;
  color: string | null;
  /** Sorted chapter numbers detected together. */
  chapters: number[];
  sourceName: string;
  detectedAt: string;
  state: UpdateState;
}
export interface UpdatesFeed {
  entries: UpdateEntry[];
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  checking: boolean;
  autoCount: number;
  trackedCount: number;
}
export type DownloadControl =
  | { action: 'pause' | 'resume' | 'clear' }
  /** Re-queue only the failed chapters of one batch (or of every batch when omitted). */
  | { action: 'retry_failed'; batchId?: string }
  /** Drop one batch from the list (finished ones) or cancel its remaining chapters. */
  | { action: 'remove'; batchId: string };

/* ---- Kavita libraries, targets and existing content ---- */
/** Formats routed to a Kavita library. ONE_SHOT follows MANGA; both novel formats follow NOVEL. */
/**
 * Formats a Kavita library can receive. `LIGHT_NOVEL`/`WEB_NOVEL`/`NOVEL`/`BOOK` replace the former
 * single `NOVEL` target (migrated to all text kinds).
 */
export type LibraryKind =
  'MANGA' | 'MANHWA' | 'MANHUA' | 'COMIC' | 'LIGHT_NOVEL' | 'WEB_NOVEL' | 'NOVEL' | 'BOOK';
export interface KavitaFolder {
  /** Folder path as Kavita sees it. */
  path: string;
  /** Same folder inside this container when it is under the mounted library, else null. */
  localPath: string | null;
  writable: boolean;
}
export interface KavitaLibrary {
  id: number;
  name: string;
  /** Kavita library type name (Manga, Comic, Book, LightNovel, …). */
  type: string;
  folders: KavitaFolder[];
  /** Formats this library receives by default when no explicit target is saved (guessed from its name/type). */
  suggestedFor: LibraryKind[];
}
export interface LibraryTarget {
  libraryId: number;
  /** Kavita-side folder path chosen inside that library. */
  folder: string;
}
/** `null` = explicitly no library for that format (downloads of that format are refused). */
export type LibraryTargets = Partial<Record<LibraryKind, LibraryTarget | null>>;
export interface KavitaSeriesSummary {
  seriesId: number;
  libraryId: number;
  libraryName: string;
  name: string;
  chapters: number;
  /** Proxied cover (`/api/kavita/image?seriesId=`), never a URL carrying the API key. */
  coverUrl: string | null;
  url: string | null;
  /** Tracked Bunko entry linked to this series, if any. */
  trackedId: number | null;
}
export interface KavitaIndexStatus {
  state: 'ok' | 'error' | 'unconfigured';
  series: number;
  syncedAt: string | null;
  /** This account's media folder inside Bunko (chosen in settings), or null when none is set. */
  mediaRoot: string | null;
  /** Folders that can be chosen: `/library` itself and its direct subfolders, with who uses each. */
  mediaRootOptions: { path: string; usedBy: string | null; available: boolean }[];
}

/* ---- Accounts ---- */
/** GET /api/auth. `setupRequired` is true only until the first account is created. */
export interface AuthState {
  authenticated: boolean;
  setupRequired: boolean;
  username: string | null;
  /** Signed-in user (null when signed out). */
  userId: number | null;
  role: UserRole | null;
}
/**
 * Every user is a fully separate Bunko instance (own settings, Suwayomi/Kavita connections,
 * library, downloads, matches). `admin` additionally manages accounts; otherwise roles are equal.
 */
export type UserRole = 'admin' | 'member';
/** GET /api/users (admin). */
export interface UserAccount {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
  lastSeenAt: string | null;
  /** The user's instance has a Kavita connection configured. */
  kavitaLinked: boolean;
}
/** POST /api/users (admin). */
export interface UserCreate {
  username: string;
  password: string;
  role: UserRole;
}
/** PATCH /api/users (admin): change role or set a new password; DELETE /api/users {id}. */
export interface UserPatch {
  id: number;
  role?: UserRole;
  password?: string;
  /** Rename the account (same rules as setup; unique). Media root `/library/<username>` follows it. */
  username?: string;
}
/** GET/PATCH /api/me — the signed-in user's own preferences. */
export interface MyAccount {
  id: number;
  username: string;
  role: UserRole;
  /** Show filtered content (per user, off by default). */
  adultContent: boolean;
}
export interface MyAccountPatch {
  adultContent?: boolean;
  /** Rename one's own account (same rules as `UserPatch.username`). */
  username?: string;
}
/** POST /api/auth/setup (first start only) and POST /api/auth (sign in). */
export interface Credentials {
  username: string;
  password: string;
}
/** POST /api/auth/password (signed in). */
export interface PasswordChange {
  currentPassword: string;
  newPassword: string;
}
