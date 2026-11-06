/** Browser-safe API contract. No database/server imports in this file. */
export type MediaType = 'MANGA' | 'NOVEL' | 'ANIME';
/** `kavita` = a series known only from Kavita (no catalog match). */
export type Provider = 'anilist' | 'mangadex' | 'mangaupdates' | 'local' | 'kavita' | 'tmdb';
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
  | 'BOOK'
  /** TV series from TMDB (live action or western animation; anime come from AniList). */
  | 'SERIES'
  /** Film from TMDB. */
  | 'MOVIE'
  /** Animated film: anime films (AniList) and western animation films (TMDB). */
  | 'ANIMATION_FILM';
export interface SourceMatch {
  sourceId: string;
  sourceName: string;
  suwayomiMangaId: number;
  mangaUrl: string;
  thumbnailUrl: string | null;
  lang: string;
}
export interface UnifiedMedia {
  /** The user's choice of kind for this work, over the provider's (e.g. a series kept as anime). */
  kindOverride?: Exclude<DiscoverKind, 'all'>;
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
/** A Jellyfin episode ready to play: its streams and where it was left. */
export interface PlaybackInfo {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  /** Proxied URL to play: the original file (direct) or Jellyfin's HLS transcode. */
  playUrl: string;
  playMethod: 'direct' | 'transcode';
  /** Streams this playback was opened with. */
  audioIndex: number | null;
  subtitleIndex: number | null;
  title: string;
  series: string | null;
  season: number | null;
  episode: number | null;
  durationMs: number | null;
  resumeMs: number;
  /** Where this playback starts (resume point, or the position of a stream change). */
  startMs: number;
  /** Source video height, to offer the qualities at or below it. */
  height: number | null;
  audio: { index: number; label: string; language: string | null; default: boolean }[];
  subtitles: {
    index: number;
    label: string;
    language: string | null;
    default: boolean;
    /** Text subtitles become a WebVTT track; image ones are burned into the video. */
    text: boolean;
    /** Proxied WebVTT address of a text subtitle. */
    url: string | null;
  }[];
}
/** One source reported by an extension's optional `health.json`. */
export interface VideoAddonSource {
  name: string;
  status: 'ok' | 'warning' | 'down';
  enabled: boolean;
}
/** Optional per-source health an extension may publish next to its manifest. */
export interface VideoAddonHealth {
  summary: { total: number; ok: number; warning: number; down: number; off: number };
  sources: VideoAddonSource[];
}
/** A video extension (Stremio addon protocol) as configured. */
export interface VideoAddon {
  /** Stable id of the manifest address (the address itself may hold account keys: server only). */
  id: string;
  host: string;
  name: string | null;
  description: string | null;
  /** What the extension offers for an episode. */
  resources: ('stream' | 'subtitles')[];
  /** `private`: on the LAN, not allowed by BUNKO_VIDEO_ALLOWED_HOSTS. */
  error: 'unreachable' | 'private' | null;
  /** Per-source health when the extension exposes `health.json`; null otherwise. */
  health: VideoAddonHealth | null;
}
/** A subtitle file offered by an extension, converted to WebVTT by Bunko. */
export interface VideoSubtitle {
  id: string;
  /** ISO 639-1 code when the extension says which language it is. */
  lang: string | null;
  /** Extension that offered it. */
  source: string;
  url: string;
}
/** One stream offered by a video extension for an episode. */
export interface VideoStream {
  id: string;
  addon: string;
  name: string;
  title: string;
  /** Direct file, HLS playlist, torrent (needs a debrid service in the addon) or other site. */
  kind: 'direct' | 'hls' | 'torrent' | 'external';
  /** Link the browser may load itself (null when the addon asks for request headers). */
  url: string | null;
  /** The same stream through Bunko: headers, plain HTTP on an HTTPS page, no CORS. */
  relayUrl: string | null;
  externalUrl: string | null;
  /** In the interface language (subtitled, dubbed or several audio tracks). */
  preferred: boolean;
  /**
   * Read from the stream's labels (an estimate, not a verified track): subtitled, dubbed or
   * several audio tracks in the interface language, original audio (`vo`), another language,
   * or nothing said (null).
   */
  version: 'sub' | 'dub' | 'multi' | 'vo' | 'other' | null;
  /** May start without asking (the user's version, or VO with their subtitles). */
  autoplay: boolean;
  /** Vertical resolution read from the labels (1080, 720, 2160…). */
  quality: number | null;
  /** False when the addon or the codec says browsers may not decode it. */
  webReady: boolean;
  /** Subtitles that come with this stream. */
  subtitles: VideoSubtitle[];
}
export interface VideoStreams {
  streams: VideoStream[];
  /** Subtitles of the episode from subtitle extensions (any stream of it). */
  subtitles: VideoSubtitle[];
  errors: string[];
}
/** One season of an anime work (AniList lists each season as its own entry). */
export interface AnimeSeason {
  number: number;
  /** Named part instead of "Season N" (a film, or a work joined by hand). */
  label?: string;
  /** TMDB season number of a series season (video extensions look episodes up with it). */
  tmdbSeason?: number;
  anilistId: number | null;
  title: string;
  year: number | null;
  status: string | null;
  episodes: number | null;
  aired: number | null;
  duration: number | null;
  nextEpisode: { number: number; airingAt: string } | null;
  list: {
    number: number;
    title: string | null;
    thumbnail: string | null;
    airDate?: string | null;
  }[];
}
/** Anime facts from AniList (episodes are the unit; seasons are separate AniList entries). */
export interface VideoDetail {
  /** The whole work: every TV season in order (one entry when there is a single season). */
  seasons?: AnimeSeason[];
  /** The season the page was opened from (a sequel's link opens the whole work there). */
  focus?: number;
  /** Series and films: ids video extensions and Jellyfin know them by. */
  ids?: { imdb: string | null; tmdb: number; kind: 'tv' | 'movie' };
  /** Planned episode count when known. */
  episodes: number | null;
  /** Minutes per episode. */
  duration: number | null;
  studios: string[];
  /** Next episode to air, when the show is airing. */
  nextEpisode: { number: number; airingAt: string } | null;
  /** Episodes aired so far (next episode − 1, or the total once finished). */
  aired: number | null;
  /** Per-episode titles and stills when AniList lists them. */
  list: {
    number: number;
    title: string | null;
    thumbnail: string | null;
    airDate?: string | null;
  }[];
}
export interface MediaDetail extends UnifiedMedia, LoadState {
  /** Series and films: main cast (TMDB credits); directors/creators are in `authors`. */
  credits?: { cast: string[] };
  video?: VideoDetail;
  jellyfin?: JellyfinPresence | null;
  /** This id is a later season of another work: the client opens that work instead. */
  workOf?: { id: string; season: number };
  tags: string[];
  relations: RelatedMedia[];
  recommendations: UnifiedMedia[];
}
/** `novel` = romans (fiction books), `book` = livres (non-fiction); LN and WN are separate. */
export type DiscoverKind =
  | 'all'
  | 'manga'
  | 'manhwa'
  | 'manhua'
  | 'comic'
  | 'lightnovel'
  | 'webnovel'
  | 'novel'
  | 'book'
  | 'anime'
  | 'series'
  | 'movies'
  | 'animation';
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
  /** AniList tags that must all apply (demographics such as Shounen are tags too). */
  tags?: string[];
  /** Minimum average score, 0–100. */
  minScore?: number;
  /** Only 18+ works (honoured only when the account shows 18+). */
  adultOnly?: boolean;
  page?: number;
  perPage?: number;
}
/** GET /api/catalog/filters?kind= — what the catalog can filter for this kind and account. */
export interface CatalogFilters {
  genres: string[];
  /** 18+ genres, listed apart (empty unless the account allows 18+). */
  adultGenres: string[];
  /** Tags by group (`catalog.tagGroup.<category>`); the `adult` group only with 18+ allowed. */
  tags: { category: string; names: string[]; adult?: boolean }[];
  /** Series and films: tags are TMDB keywords, found by searching (`/api/catalog/keywords`). */
  keywordSearch: boolean;
  status: boolean;
  year: boolean;
  season: boolean;
  score: boolean;
  /** The account shows 18+: the "18+ only" filter is available. */
  adult: boolean;
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
    | 'rakuten'
    | 'anilist'
    | 'tmdb';
  /** `volume` = a new tome/edition (books, LN volumes, BD albums); `episode` = an episode airing;
   *  `film` = a film released. */
  unit?: 'chapter' | 'volume' | 'episode' | 'film';
  /** Anime season of the episode, when known. */
  season?: number | null;
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
  /** Several chapters of the work that day: `chapter` is the first, this the last. */
  chapterTo?: number | null;
  /** Anime season of an aired episode, when known. */
  season?: number | null;
  /** Releases merged into this card (1 when alone). */
  count?: number;
  /** `episode` for anime airings; chapters otherwise. */
  unit?: 'chapter' | 'episode' | 'film';
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
  /** Radarr (films). Sonarr and Radarr options: 0 / '' = the service's first profile / folder. */
  radarrUrl: string;
  radarrApiKey: string;
  sonarrQualityProfile: number;
  sonarrRootFolder: string;
  /** Folder for anime series (Sonarr's anime type); empty = the series folder. */
  sonarrAnimeRootFolder: string;
  radarrQualityProfile: number;
  radarrRootFolder: string;
  /** qBittorrent Web UI: progress of what Prowlarr sends to it (and of everything else). */
  qbittorrentUrl: string;
  qbittorrentUsername: string;
  qbittorrentPassword: string;
  /** qBittorrent ≥ 5.2 API key (qbt_…), used instead of the login when set. */
  qbittorrentApiKey: string;
  /** Jellyfin server address and API key; `jellyfinUser` names whose watched state counts. */
  jellyfinUrl: string;
  jellyfinApiKey: string;
  jellyfinUser: string;
  /** Video extensions: Stremio addon manifest URLs (stored encrypted, never sent to the browser). */
  videoAddons: string[];
  /** Version tried first: original audio with subtitles, or dubbed. */
  videoAudio: 'original' | 'dubbed';
  /** Also start other languages by themselves when nothing matches (default false). */
  videoAnyLanguage: boolean;
  /** Role per Jellyfin library id; libraries not listed use the detected role. */
  jellyfinLibraries: Record<string, JellyfinRole>;
  /** Follow Jellyfin anime automatically (matched to AniList when unambiguous). Default true. */
  autoImportJellyfin: boolean;
  /** TraDoc integration API address, e.g. `http://tradoc.local:2507/api/v1`; empty = unused. */
  tradocUrl: string;
  /** TraDoc connection key (`tdk_…`), created in TraDoc → Settings → Integrations. */
  tradocApiKey: string;
  /** Kavita-side path of the folder mounted at /library in this container. */
  kavitaLibraryPath: string;
  /** Kavita library and folder receiving each format; unset kinds use the suggested library. */
  libraryTargets: LibraryTargets;
  /** Follow every Kavita series automatically (matched to the catalog when possible). Default true. */
  autoImportKavita: boolean;
  /** Shared optional catalog credentials, managed by admins; empty = unused or keyless mode. */
  googleBooksApiKey: string;
  /** TMDB API key (v3) or read access token (v4): series and films. Shared by the admin. */
  tmdbApiKey: string;
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
  /** With 18+ allowed: the whole interface shows 18+ works only (kinds menu switch). */
  adultMode: boolean;
  /** With 18+ off, also leave out extensions marked NSFW (default true). */
  hideNsfwSources: boolean;
  /**
   * The interface's universe: one kind (only that kind everywhere) or `all` (everything together,
   * with a kind menu on each page). Default `all`.
   */
  universe: DiscoverKind;
  /** Universes offered in the switcher (empty = every kind). */
  universes: Exclude<DiscoverKind, 'all'>[];
  /** Kinds that existed when `universes` was last saved (later kinds start enabled). */
  universesKnown: Exclude<DiscoverKind, 'all'>[];
  /** Offer "Everything" in the switcher (default true). */
  showAllUniverse: boolean;
  /**
   * Priority of the kinds, first to last: the order of the switcher, of the home shelves and of
   * the mix in "Everything". Always holds every kind (missing ones are appended).
   */
  kindOrder: Exclude<DiscoverKind, 'all'>[];
  /** Live TV in the kinds menu (its own universe, never part of "everything"). Default true. */
  liveEnabled: boolean;
  /** The interface shows live TV (chosen from the kinds menu). */
  liveMode: boolean;
  /** Countries of the live home (index codes); empty = the browser's country. */
  liveCountries: string[];
  /** The user's own M3U playlist (operator, subscriptions); may hold credentials. */
  livePlaylistUrl: string;
  /** XMLTV guides (plain or .gz). */
  liveGuideUrls: string[];
  /** Where outside reading progress is read from (Bunko's own reader always counts). */
  progressSource: 'suwayomi' | 'kavita';
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
  | 'radarrApiKey'
  | 'qbittorrentPassword'
  | 'qbittorrentApiKey'
  | 'tradocApiKey'
  | 'jellyfinApiKey'
  | 'googleBooksApiKey'
  | 'tmdbApiKey'
  | 'metronApiToken'
  | 'metronPassword'
  | 'rakutenApplicationId'
  | 'rakutenAccessKey'
  | 'hardcoverToken'
  | 'livePlaylistUrl';
export type PublicSettings = Omit<Settings, SecretSetting> & {
  secretsConfigured: Record<SecretSetting, boolean>;
  /** Shared availability is visible to members; credential changes/probes require an admin. */
  catalogs: { canManage: boolean; configured: Record<CatalogProvider, boolean> };
};
export type CatalogProvider = 'googlebooks' | 'metron' | 'rakuten' | 'hardcover' | 'tmdb';
export const catalogSettingKeys = [
  'googleBooksApiKey',
  'tmdbApiKey',
  'metronApiToken',
  'metronUsername',
  'metronPassword',
  'rakutenApplicationId',
  'rakutenAccessKey',
  'hardcoverToken',
] as const satisfies readonly (keyof Settings)[];
export type CatalogSetting = (typeof catalogSettingKeys)[number];
export type SettingsPatch = Partial<Settings>;
/** A work's manual Jellyfin link: a series (and season), or `none` to keep it unlinked. */
export type JellyfinLink = { seriesId: string; season: number } | 'none';
/** What Jellyfin holds for an anime (owned and watched episodes of the linked season). */
export interface JellyfinPresence {
  seriesId: string;
  name: string;
  /** Owned and watched episodes per Jellyfin season (season numbers match the work's seasons). */
  bySeason: {
    season: number;
    owned: number[];
    played: number[];
    /** Episode number → Jellyfin item id, for "play in Jellyfin" links. */
    episodeIds: Record<number, string>;
  }[];
  /** Total owned episodes across seasons (specials excluded). */
  ownedCount: number;
  playedCount: number;
  url: string;
  manual: boolean;
}
/** What a Jellyfin library holds for Bunko (anime now; series and films in later phases). */
export type JellyfinRole = 'anime' | 'series' | 'movies' | 'animation' | 'ignore';
export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string | null;
  /** Effective role: the account's choice, else the detected one. */
  role: JellyfinRole;
  detected: JellyfinRole;
}
export interface JellyfinSeriesSummary {
  id: string;
  name: string;
  year: number | null;
  seasons: number[];
  episodes: number;
}
export interface TrackedMedia {
  id: number;
  jellyfinLink?: JellyfinLink | null;
  /** Personal like, independent of reading status and owning/downloading the work. */
  favorite?: boolean;
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
    pageCount?: number;
    unit?: 'chapter' | 'volume';
    volume?: number | null;
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
/**
 * One piece of background work as the notification panel shows it: what runs, for which side of
 * the app (reading or video), and how far it is (done / total; null total = indeterminate).
 */
export interface ActivityTask {
  id: string;
  kind: 'downloads' | 'matching' | 'releases' | 'jellyfin' | 'translations' | 'kavita';
  scope: 'reading' | 'video';
  done: number;
  total: number | null;
  /** Title being worked on, when there is one. */
  detail: string | null;
}
export type BackgroundJobId =
  | 'update-check'
  | 'release-ingestion'
  | 'source-matching'
  | 'kavita-index'
  | 'jellyfin'
  | 'catalog-linking'
  | 'covers'
  | 'translations';
/** What a background job works with: the activity panel groups jobs by it. */
export type BackgroundJobGroup =
  'suwayomi' | 'kavita' | 'jellyfin' | 'catalogs' | 'bunko' | 'tradoc';
/** One background job of the account, as the activity panel shows it. */
export interface BackgroundJob {
  id: BackgroundJobId;
  group: BackgroundJobGroup;
  running: boolean;
  lastAt: string | null;
  lastMs: number | null;
  /** The last run failed. */
  failed: boolean;
  /** Next automatic run; null for work that runs whenever there is some. */
  nextAt: string | null;
  /** Work waiting or in progress (works to check, series to import…). */
  pending: { done: number; total: number } | null;
}
export interface LibraryActivity {
  /** Everything running now, for the header indicator and notification panel. */
  tasks?: ActivityTask[];
  /** Tenant library revision; clients invalidate stale sheets/lists when background writes land. */
  revision?: number;
  /** Separate durable domains avoid reloading source lists after page turns or release ingestion. */
  revisions?: { content: number; progress: number; releases: number };
  activeDownloads?: number;
  /** Followed titles currently hidden because 18+ content is off (never hidden silently). */
  hiddenAdult: number;
  /** Followed comics waiting for automatic source matching, and the one being searched now. */
  matching: { queued: number; current: string | null };
  /** Jellyfin anime still being added to the library (series handled / all). */
  jellyfinImport?: { done: number; total: number } | null;
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
  readSource: 'kavita' | 'suwayomi' | 'none';
}
export interface TrackPatch {
  id: number;
  favorite?: boolean;
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
  /** Jellyfin media server; `version` when reachable. */
  jellyfin: { state: ServiceState; version: string | null };
  /** TraDoc translation engine; `version` is TraDoc's own version when reachable. */
  tradoc: { state: ServiceState; version: string | null };
  /** Sonarr (series, anime) and Radarr (films). */
  sonarr?: { state: ServiceState; version: string | null };
  radarr?: { state: ServiceState; version: string | null };
  prowlarr?: { state: ServiceState; version: string | null };
  qbittorrent?: { state: ServiceState; version: string | null };
}
export type ArrService = 'sonarr' | 'radarr';
/** GET /api/arr/options?service= — what the settings let the user choose. */
export interface ArrOptions {
  profiles: { id: number; name: string }[];
  folders: { path: string; freeSpace: number | null }[];
}
/** GET /api/arr/request?mediaId= — a work's place in Sonarr/Radarr. */
export interface MediaRequestState {
  service: ArrService | null;
  configured: boolean;
  /**
   * unsupported: no TVDB/TMDB identity; unconfigured: the service is not set up; absent: not in
   * it; wanted: monitored, nothing on disk; partial: some episodes; downloading: in the download
   * client's queue; available: everything on disk.
   */
  state:
    'unsupported' | 'unconfigured' | 'absent' | 'wanted' | 'partial' | 'downloading' | 'available';
  error: string | null;
  files?: number;
  total?: number;
  queued?: number;
  /** Share of the queued downloads already received (0–1), when the client reports sizes. */
  progress?: number | null;
  monitored?: boolean;
  /** Prowlarr is set up: a manual search by name is possible even without Sonarr/Radarr. */
  prowlarr?: boolean;
}
export type SearchService = ArrService | 'prowlarr';
/** The few fields of a work "Pick up where you left off" needs (kind, 18+, card). */
export type ContinueMedia = Pick<
  UnifiedMedia,
  'id' | 'title' | 'coverUrl' | 'type' | 'format' | 'origin' | 'adult' | 'color' | 'kindOverride'
>;
/** PUT /api/continue — something started in Bunko's reader or player. */
export interface ContinueUpdate {
  media: ContinueMedia;
  kind: 'read' | 'watch';
  /** "Ch. 12", "S2 · Ep. 5"… */
  label: string;
  /** Where "resume" goes: the reader page or the sheet opening the player on the episode. */
  href: string;
  /** Inside the chapter or episode, 0–1, when known. */
  position: number | null;
}
/** GET /api/continue — newest first, already filtered by the 18+ preference. */
export interface ContinueItem extends ContinueUpdate {
  updatedAt: string;
  /** Library entry when the work is followed (progress bar). */
  trackedId: number | null;
  progress: LibraryProgress | null;
}
/** POST /api/arr/prepare — the work is in Sonarr/Radarr (added unmonitored, never searched). */
export interface MediaSearchTarget {
  service: ArrService;
  /** Sonarr: seasons with their episodes and files on disk. */
  seasons: { number: number; episodes: number; files: number }[];
}
/** One release of an interactive search (Sonarr/Radarr) or a manual Prowlarr search. */
export interface MediaRelease {
  service: SearchService;
  guid: string;
  indexerId: number;
  title: string;
  indexer: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  /** Quality as Sonarr/Radarr name it (e.g. WEBDL-1080p); Prowlarr: from the title. */
  quality: string | null;
  resolution: string | null;
  codec: string | null;
  languages: string[];
  publishDate: string | null;
  protocol: string;
  /** Sonarr/Radarr would not pick it themselves (their reasons); it can still be taken. */
  rejected: boolean;
  rejections: string[];
  fullSeason: boolean;
  episodes: number[];
  infoUrl: string | null;
}
/** GET /api/arr/grabs — what was sent from Bunko, with live progress. */
export interface MediaGrab {
  id: number;
  mediaId: string;
  title: string;
  coverUrl: string | null;
  service: SearchService;
  releaseTitle: string;
  size: number | null;
  createdAt: string;
  state:
    'sent' | 'queued' | 'downloading' | 'paused' | 'importing' | 'completed' | 'failed' | 'gone';
  progress: number | null;
  /** Bytes per second while downloading. */
  speed: number | null;
  /** Seconds left, when the client knows. */
  eta: number | null;
  message: string | null;
}

/* ---- Book translation through TraDoc (contract for /api/translations/*) ---- */
export type TranslationMode = 'replace' | 'separate';
export type TranslationState =
  | 'queued'
  | 'pending'
  | 'running'
  | 'paused'
  | 'failed'
  | 'importing'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'restored';
/** An owned text file of a work, as Kavita indexes it. */
export interface TranslationFile {
  /** Kavita-side path; identifies the file in translation requests. */
  path: string;
  name: string;
  volume: number | null;
  sizeBytes: number | null;
}
export interface TranslationJob {
  id: number;
  trackedId: number;
  fileName: string;
  sourceLang: string;
  targetLang: string;
  provider: string | null;
  model: string | null;
  mode: TranslationMode;
  state: TranslationState;
  /** 0–1 while TraDoc reports progress. */
  progress: number | null;
  /** Safe error code only. */
  error: string | null;
  /** The original file is kept outside the library and can be put back. */
  backup: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TranslationModels {
  default: { provider: string | null; model: string | null };
  providers: { provider: string; models: string[]; error: string | null }[];
}
export interface TranslationRequest {
  trackedId: number;
  paths: string[];
  sourceLang: string;
  targetLang: string;
  provider?: string;
  model?: string;
  mode: TranslationMode;
}
export type TranslationAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'restore' | 'remove';

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
  /** Setup restores the first administrator (BUNKO_RESET_ACCOUNT) and asks for its code. */
  recovery?: boolean;
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
/**
 * What a member may do (admins can do everything). New accounts get every permission; an admin
 * takes away what a member should not do.
 */
export const PERMISSIONS = ['services', 'extensions', 'downloads', 'translate', 'adult'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export interface UserAccount {
  id: number;
  /** Granted permissions (always all of them for admins). */
  permissions: Permission[];
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
  /** Members only: the full list of granted permissions. */
  permissions?: Permission[];
}
/** GET/PATCH /api/me — the signed-in user's own preferences. */
export interface MyAccount {
  /** What this account may do; the interface hides or explains the rest. */
  permissions: Permission[];
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

/** Bunko's book reader: one EPUB or PDF file of a work in the Kavita library. */
export interface BookProgress {
  /** EPUB: index in the reading order; PDF: page index. */
  part: number;
  /** Position inside that part, 0–1. */
  offset: number;
  /** Whole file, 0–1. */
  fraction: number;
  updatedAt: string;
}
export interface BookFile {
  key: string;
  name: string;
  volume: number | null;
  format: 'epub' | 'pdf';
  sizeBytes: number | null;
  progress: BookProgress | null;
}
export interface BookTocEntry {
  label: string;
  depth: number;
  part: number;
  anchor: string | null;
}
export interface BookManifest {
  key: string;
  name: string;
  volume: number | null;
  format: 'epub' | 'pdf';
  title: string | null;
  /** The whole file (PDF rendering, download). */
  url: string;
  /** EPUB documents in reading order, with their size to weigh progress. */
  spine: { href: string; weight: number }[];
  toc: BookTocEntry[];
  progress: BookProgress | null;
  prevKey: string | null;
  nextKey: string | null;
}
export interface BookProgressUpdate {
  mediaId: string;
  file: string;
  part: number;
  offset: number;
  fraction: number;
}

/** Live TV: a channel of the public index or of the user's own playlist. */
export interface LiveProgramme {
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  start: string;
  stop: string;
  image: string | null;
}
export interface LiveChannel {
  /** Index id (`TF1.fr`) or `m3u:<key>` for a playlist channel the index does not know. */
  id: string;
  name: string;
  logo: string | null;
  /** ISO country code of the index (`UK` for the United Kingdom). */
  country: string | null;
  categories: string[];
  /** A stream can be played (free stream or the user's playlist). */
  playable: boolean;
  /** The user's playlist provides it (a subscription). */
  fromPlaylist: boolean;
  quality: string | null;
  now: LiveProgramme | null;
  next: LiveProgramme | null;
  favorite: boolean;
}
export interface LiveStreamChoice {
  label: string;
  quality: string | null;
  fromPlaylist: boolean;
  /** Bunko's relay address for this stream. */
  url: string;
}
export interface LiveChannelDetail extends LiveChannel {
  website: string | null;
  network: string | null;
  schedule: LiveProgramme[];
  streams: LiveStreamChoice[];
}
export interface LiveHome {
  /** The channel index is being downloaded for the first time. */
  pending: boolean;
  countries: string[];
  onNow: LiveChannel[];
  favorites: LiveChannel[];
  playlist: LiveChannel[];
  shelves: { category: string; channels: LiveChannel[] }[];
}
export interface LiveCatalog {
  pending: boolean;
  channels: LiveChannel[];
  total: number;
  page: number;
  pageSize: number;
  countries: { code: string; name: string; flag: string | null; count: number }[];
  categories: { id: string; count: number }[];
}
export interface LiveStatus {
  channels: number;
  playable: number;
  programmes: number;
  indexAt: string | null;
  guides: { url: string; at: string | null; error: string | null }[];
  playlist: { configured: boolean; entries: number; matched: number; at: string | null; error: string | null };
}
