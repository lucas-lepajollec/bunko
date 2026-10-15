# HTTP API contract

All endpoints are same-origin. Unless marked public, send `Authorization: Bearer <access-token>` or the `kaviseerr_session` cookie from `/api/auth`. Never put keys in query strings. POST/PATCH/DELETE JSON requests require `Content-Type: application/json`; maximum body size is 1 MiB. A supplied Origin must match the application host. Responses are uncached except private, bounded image caching.

Types below refer to **the complete browser-safe definitions in `src/types/shared.ts`**. Responses are the named value directly, not an extra `{data: ...}` envelope. Failures use `ApiError`: `{ "error": { "code": "...", "message": "..." } }`. Do not display raw HTML from upstream synopses.

## Endpoint map

| Method and path                 | Input                                                                | Success response                                                                                              |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /` (public)                | None                                                                 | French browser interface; service health remains at `/api/health`                                             |
| `GET /api/health` (public)      | None                                                                 | `{status:"ok",version:"0.1.0"}`; 503 on SQLite failure                                                        |
| `POST /api/auth` (public)       | `{token:string}`                                                     | 200 `{authenticated:true}` plus HttpOnly SameSite=Strict cookie, seven days                                   |
| `GET /api/auth`                 | None                                                                 | `{authenticated:true}`                                                                                        |
| `DELETE /api/auth`              | None                                                                 | 204; expires cookie                                                                                           |
| `GET /api/settings`             | None                                                                 | `PublicSettings`                                                                                              |
| `PATCH /api/settings`           | `SettingsPatch`                                                      | `PublicSettings`; if extensionRepos is supplied, applies it to Suwayomi too                                   |
| `GET /api/search`               | `q`: trimmed 1–200 chars; optional `type=MANGA\|NOVEL\|ANIME`        | `SearchResponse`                                                                                              |
| `GET /api/discover`             | Optional kind, sort, genre, status, year, season, page, perPage; see below | `DiscoverPage`                                                                                            |
| `GET /api/search/stream`        | `q`: 1–200 chars                                                     | SSE `SearchEventMap`                                                                                          |
| `POST /api/catalog/sync`        | `{pages?:number}` integer 1–50, default 5                            | SSE `SearchEventMap`; one source_result per popular page                                                      |
| `GET /api/sources`              | None                                                                 | `SourceInfo[]`: all installed sources in preferred languages, including disabled sources, ordered by priority |
| `GET /api/sources/preferences`  | None                                                                 | `SourcePreferences`; default languages `["fr"]`                                                               |
| `PUT /api/sources/preferences`  | `SourcePreferences`                                                  | Saved `SourcePreferences`                                                                                     |
| `GET /api/sources/[id]/filters` | Positive signed 64-bit decimal source ID string                      | `SourceFilter[]`                                                                                              |
| `POST /api/sources/[id]/browse` | `BrowseRequest`                                                      | `BrowsePage`                                                                                                  |
| `GET /api/updates`              | None                                                                 | `UpdatesFeed`, latest 200 detection groups                                                                    |
| `POST /api/updates/check`       | No body                                                              | 202 `{ok:true}`; durable nonblocking check request                                                            |
| `POST /api/downloads/control`   | `DownloadControl`                                                    | New `DownloadStatus`                                                                                          |
| `GET /api/extensions`           | Optional `lang=fr`                                                   | `Extension[]`; omitting lang lists all                                                                        |
| `POST /api/extensions/action`   | `ExtensionAction`                                                    | `{ok:true}` after upstream action                                                                             |
| `GET /api/suwayomi/image`       | `path`: approved Suwayomi relative thumbnail/icon path               | Authenticated image bytes, private cache 300s                                                                 |
| `GET /api/manga/chapters`       | `suwayomiMangaId` OR `sourceId` + `mangaUrl`                         | `ChaptersResponse`                                                                                            |
| `POST /api/manga/chapters`      | `{sources:ChapterSelection[]}` 1–20 selections                       | `ChaptersResponse` with merged numbers and all alternatives                                                   |
| `POST /api/downloads/enqueue`   | `EnqueueRequest`; 1–500 positive chapterIds and complete media       | 202 `DownloadBatch`; persisted before asynchronous enqueue                                                    |
| `GET /api/downloads`            | None                                                                 | `DownloadsSnapshot`                                                                                           |
| `GET /api/downloads/stream`     | None                                                                 | SSE `DownloadEventMap`, ~1500 ms after each upstream status response                                          |
| `GET /api/downloads/batches`    | None                                                                 | `DownloadBatch[]`, newest first, including persisted errors                                                   |
| `POST /api/downloads/batches`   | `{id:string,action:"retry"}` UUID of an error batch                  | 202 `DownloadBatch`; imported IDs preserved                                                                   |
| `GET /api/arr/releases`         | `ReleaseQuery`; see below                                            | `Release[]`                                                                                                   |
| `POST /api/arr/releases`        | `GrabReleaseRequest`                                                 | 202 `{ok:true}` after upstream accepts                                                                        |
| `GET /api/tracked`              | Optional `refresh=progress`                                          | `TrackedMedia[]`                                                                                              |
| `POST /api/tracked`             | `TrackRequest`                                                       | 201 `TrackedMedia`; repeated provider ID returns existing entry                                               |
| `PATCH /api/tracked`            | `TrackPatch` (status, autoDownload, kavitaSeriesId, ordered sources) | Updated `TrackedMedia`                                                                                        |
| `DELETE /api/tracked`           | `{id:number}`                                                        | `{ok:true}`; does not delete media files or batches                                                           |

All chapter/manga/tracked numeric IDs must be positive integers. **Source IDs are 64-bit decimal strings**, never JavaScript numbers. Normal source IDs fit signed 64-bit positive integers. Chapter `number:null` means an unnumbered special; each special retains a unique source/ID key. Duplicate chapter numbers retain `variants[]` so the user can select the desired team/source. Enqueue only the chosen variant of each chapter.

The URL-based chapter lookup resolves an already discovered Suwayomi manga by exact source ID and source-relative manga URL. If unknown it returns `MANGA_NOT_INDEXED` (404); perform a deep search first. There is no universal arbitrary-URL scraper. Source display fields from chapter POST are labels only; they cannot change the upstream manga ID.

## Settings

`Settings` is the write shape, `PublicSettings` the read shape. The read response contains `secretsConfigured` booleans for `suwayomiPassword`, `kavitaApiKey`, `sonarrApiKey`, `prowlarrApiKey`, with **no corresponding secret fields**. A frontend must send only edited fields; it must never send a displayed mask as a key. Empty strings explicitly clear optional keys/URLs; `suwayomiUrl` remains a required HTTP(S) base URL. URL credentials, query strings and fragments are rejected; put credentials in the separate key fields.

`kavitaLibraryPath` is an absolute POSIX path **inside Kavita**, default `/library`. The local application mount is controlled by the environment, not a client-supplied filesystem path. `favoriteSourceIds` remains a legacy setting: its current value migrates once, on first source-preferences read, to `SourcePreferences.enabledSourceIds`. Later edits to that legacy field do not override saved preferences. `updateIntervalMinutes` is an integer from 5 to 1440, default 15, exposed unchanged in `PublicSettings`. `extensionRepos:[]` means no extension repositories. Repository changes are persisted locally before Suwayomi applies them; if the upstream fails the request reports failure but the saved value remains, and resending the same PATCH retries application.

## Search and streams

`UnifiedMedia` contains stable provider-prefixed IDs, media type, explicit nullable metadata, authors, tags, aliases, provider identifiers, actual source matches and tracked/Kavita linkage. Metadata providers can fail independently; read `providers[].status`. No-type searches include both AniList manga/novels and a separate anime request, so two AniList outcomes can appear. Explicit `MANGA` normally has four outcomes; `NOVEL` two; `ANIME` one. No fabricated results are inserted when a provider is unavailable.

`UnifiedMedia.startDate` is a nullable partial ISO publication date: `"YYYY"`, `"YYYY-MM"` or `"YYYY-MM-DD"`. AniList supplies the available year/month/day; MangaDex and MangaUpdates supply a year; Suwayomi-only results return `null`. Search deduplication retains the most precise available date. Older submitted media payloads may omit this field; validation defaults it to `null`.

## Discovery

`GET /api/discover` returns `{items:UnifiedMedia[],page,hasNextPage}` from AniList's reading catalog (manga and novels, excluding adult entries). Optional query parameters:

| Parameter | Accepted values | Default |
| --- | --- | --- |
| `kind` | `all`, `manga` (JP), `manhwa` (KR), `manhua` (CN), `novel` | `all` |
| `sort` | `trending`, `popular`, `score`, `new` | `trending` |
| `genre` | Genre string, maximum 60 characters | Omitted |
| `status` | `RELEASING`, `FINISHED` | Omitted |
| `year` | Integer 1900–2100 | Omitted |
| `season` | `WINTER` (Jan–Mar), `SPRING` (Apr–Jun), `SUMMER` (Jul–Sep), `FALL` (Oct–Dec); requires `year` | Omitted |
| `page` | Integer 1–200 | `1` |
| `perPage` | Integer 1–50 | `24` |

For example, `/api/discover?kind=manga&year=2026&season=SPRING&sort=popular` selects titles whose publication began in April–June 2026. Year alone selects the entire publication year, including year-only dates. Season filtering requires a known month. Invalid parameters, including season without year, return HTTP 400 `VALIDATION_ERROR`.

Date filters use AniList's exclusive `startDate_greater` / `startDate_lesser` FuzzyDateInt bounds, including partial dates within the requested period and excluding the next period. `sort=new` orders by publication start descending, then popularity, requires popularity **greater than 300**, and restricts dates to before tomorrow in UTC while excluding entirely unknown dates. Its upper bound is intersected with the requested year/season, so future periods return no titles. Partial dates retain their provider precision. Unset GraphQL variables are omitted. The bounded ten-minute discovery cache includes all effective variables, including the date bounds; the `new` cache key changes at UTC midnight.

## Search stream behavior

Each network metadata request has a 2500 ms deadline, rather than a guaranteed sub-200 ms end-to-end response. Repeated searches have a bounded 30-second server cache. The UI should debounce, cancel stale searches and cache locally. Deep search runs one four-second query per enabled source in preferred languages. Both deep search and `/api/media/sources` start requests in preference priority order and stream results in completion order. Disconnect cancels source requests. Events:

```text
event: sources
data: {"sources":[...]}

event: source_result
data: {"source":{...},"results":[...],"titles":[...],"hasNextPage":false,"durationMs":120}

event: source_error
data: {"source":{...},"code":"UPSTREAM_TIMEOUT"}

event: done
data: {"completed":3}
```

`source_result.results[i]` corresponds to `titles[i]`. `done.completed` counts sources attempted, including failures; sync can emit multiple pages for each source. No sources is a legitimate empty sources event followed by `done` with zero. A setup/stream-wide failure emits `error` with `{code,message}`. Comment heartbeats occur every 15 seconds. `EventSource` automatically reconnects: **close it on done and on component cleanup**. Deep search is a finite operation; download status is continuous. For the POST sync stream use fetch + a real SSE parser; a chunk is not necessarily a full event.

Downloads emit `snapshot` with a `DownloadsSnapshot` and `error` with `{code,message}`. The exact Suwayomi states are retained; upstream progress is a 0–1 fraction and should be multiplied by 100 for display. This API does not invent download speed or ETA when Suwayomi does not expose them. A queue error is not completion. Batches distinguish enqueuing/downloading/importing/scanning/completed/error. Worker imports/scans continue after the stream is closed.

Use `thumbnailUrl` and extension `iconUrl` exactly as returned: these are application-relative authenticated image-proxy URLs. A native image element or an unoptimized Next image carries the same-origin cookie; an unauthenticated server-side image optimizer cannot retrieve them. The proxy only permits `/api/v1/manga/<numeric-id>/thumbnail` and `/api/v1/extension/icon/<package>`, limits bytes and rejects active SVG/HTML. Metadata covers/banners remain public HTTPS provider URLs.

## Arr interactive search

- Sonarr: `?provider=sonarr&seriesId=123&seasonNumber=1&episodeNumber=2`. `seriesId` required; season/episode optional. If provider is omitted, the presence of seriesId selects Sonarr.
- Prowlarr: `?provider=prowlarr&query=Title`. Query required. Without provider or seriesId, Prowlarr is selected.
- POST the selected release's own `{provider,guid,indexerId}`. Sonarr receives `/api/v3/release`; Prowlarr receives `/api/v1/search`. GUIDs are opaque and provider-specific. Search again if the upstream cache expires.
- Tags are parsed from the actual title; missing resolution/codec/seeders stay null. `sizeGb` uses GiB (1024³ bytes), rounded to two decimals; label it GiB. Missing seeders must never be presented as zero. Display rejection reasons and require a deliberate user selection before grabbing.

## Tracking and imports

`TrackRequest` accepts optional `status` (default `READING`), `autoDownload`, `kavitaSeriesId` and ordered `sources`. `TrackPatch` requires `id` and accepts the same state fields. Status is one of `PLANNING`, `READING`, `PAUSED`, `COMPLETED`, `DROPPED`; caught-up is derived by the frontend. `autoDownload=true` requires selected manga/novel sources and is rejected for anime. Source order is preserved and the first available variant is preferred during automatic MANGA checks.

Each `TrackedMedia` returns `status`, `progress`, `newChapters`, and `lastReadAt`. `progress.owned` counts distinct imported numeric chapter numbers, including fractional numbers; duplicate source variants count once. `read` is null until a successful Kavita progress fetch, then the highest completely read numeric chapter (0 if none). A partially read chapter does not advance `read`. `unread` counts owned numbers above `read`, or all owned numbers when `read` is null. `released` is the maximum of metadata chapters and numeric chapters seen on the selected sources. `newChapters` counts distinct observed numeric chapters not imported locally. Unnumbered specials retain their upstream identity for download/detection but do not affect numeric counts. Imported archives are linked by media ID, AniList ID or MangaDex ID, including imports made before tracking.

Kavita progress refreshes on the worker update cycle and on `GET /api/tracked?refresh=progress`. The latter returns the full tracked array after at most 15 seconds of refresh work, with up to four entries in flight. Failure preserves the last successful progress. `readSource` is `kavita` after a successful fetch, otherwise `none`; `lastReadAt` comes from Kavita's reading timestamps. A saved `kavitaSeriesId` is used directly. Otherwise the backend searches the written folder name and title, prefers an exact `kavitaLibraryPath/seriesName(media)` folder match, and falls back to one unambiguous exact title/alias match. The resolved ID is saved. Explicitly changing/clearing the linkage through PATCH clears cached progress until refreshed. API-key and JWT authentication modes use the configured Kavita user.

Enqueue requires a full `UnifiedMedia` so metadata survives a restart. If Kavita is not configured, downloaded chapters can still be imported, but the batch ends in an error at scan; configure Kavita then retry. Retry keeps imported files. CBZ transfer and rewriting are bounded; errors expose safe codes.

## Sources and browsing

`GET /api/sources` returns every installed source matching `SourcePreferences.languages`, including disabled sources. `enabledSourceIds` is an ordered list of positive signed 64-bit **strings**. An empty list enables all matching sources in Suwayomi order. Disabled sources have `priority:null`; enabled priorities follow preference positions. `iconUrl` uses the existing authenticated image proxy and `extensionId` is the providing package when available. `GET /api/sources/preferences` reads preferences and `PUT` replaces both fields, for example:

```json
{ "enabledSourceIds": ["9223372036854775806", "9007199254740993"], "languages": ["fr", "en"] }
```

Search, automatic media matching, and catalog sync use enabled sources; browsing a disabled source remains possible. Source health persists the latest search/browse latency, checked timestamp and safe error code: `slow` above 4000 ms, `ok` otherwise, `error` on failure and `unknown` before a call. Recognizable GraphQL Cloudflare challenges or HTTP `cf-mitigated: challenge` responses become `CLOUDFLARE`; ambiguous HTTP failures retain generic codes. A four-second search deadline can report a timeout rather than a successful slow result.

`GET /api/sources/[id]/filters` maps the pinned Suwayomi filter union to header, separator, select, text, checkbox, tristate, sort and group. Group children have positions relative to their group. Filters preserve defaults, including false, empty text and null sort selection. Nesting is bounded to eight group levels. The source must be installed in the selected languages; it need not be enabled.

`POST /api/sources/[id]/browse` takes an explicit positive page, mode `POPULAR`, `LATEST` or `SEARCH`, optional query (up to 200 chars) and optional filters. Each filter change has `position` and exactly one state field. A group change wraps its child, for example:

```json
{
  "mode": "SEARCH",
  "query": "Title",
  "page": 1,
  "filters": [{ "position": 7, "groupChange": { "position": 0, "triState": "INCLUDE" } }]
}
```

The backend sends `fetchSourceManga` with `source`, `type`, `query`, `page` and `filters`, indexes results in FTS, and returns `{source,items,page,hasNextPage}`. Items include `trackedId` when the Suwayomi manga is selected by a tracked entry. Suwayomi applies filters to SEARCH; POPULAR/LATEST follow the upstream source's own listing behavior. Browse has a 30-second upstream deadline. Unsupported latest or extension failures use structured upstream errors.

## Updates and download controls

The durable worker checks **all tracked MANGA entries with selected sources**, including manual titles, using `updateIntervalMinutes`. First check treats currently discovered, unimported chapters as new. Observations prevent repeated entries on later checks/restarts. Detection groups prefer the first selected source for duplicate numbers, group by tracked series/source/check, and keep each detection group whole while splitting automatic batches at 500 chapters. Manual groups are `pending`; automatic groups persist a batch and become `queued`. The feed derives `downloading` from downloading/importing/scanning, `downloaded` only when every linked batch completes, and `error` on batch failure. Retrying a batch updates the feed too. Partial manual enqueues leave remaining chapters pending after the selected chapters complete. Observations and automatic batch creation share a transaction.

`GET /api/updates` returns `{entries,lastCheckAt,nextCheckAt,checking,autoCount,trackedCount}`. Times are ISO strings or null before a first check; counts refer to MANGA entries with sources, and `autoCount` is their automatic subset. `checking` follows a live worker lease. `lastCheckAt` is the most recent check start; next time is that timestamp plus the configured interval. Per-source failures preserve partial results and retry on the next cycle. A check has a two-minute source-work deadline plus the bounded progress refresh; unfinished work requests another cycle. `POST /api/updates/check` persists a request and returns 202 immediately; repeated requests during an active check do not start duplicate work. Restart retries an interrupted check after acquiring the worker lease. Processing existing batches may delay a requested or scheduled check.

For a pending entry, find its `TrackedMedia` using `trackedId`, POST its ordered selections as `{sources:[...]}` to `/api/manga/chapters`, choose variants whose numbers appear in `entry.chapters`, then POST `{chapterIds,media:tracked.media}` to `/api/downloads/enqueue`. Existing update groups link to manual batches (including alternate source variants with the same observed number). No extra enqueue endpoint is required. Unnumbered specials are available through the chapter table; the feed's numeric `chapters` array omits them.

`POST /api/downloads/control` takes `{"action":"pause"}`, `{"action":"resume"}` or `{"action":"clear"}` and invokes Suwayomi `stopDownloader`, `startDownloader`, or `clearDownloader` with empty input. It returns the mutation's new `DownloadStatus` with a 35-second deadline. Clear operates on Suwayomi's queue; persisted import batches remain, and queue emptiness does not complete them. Failed batches still use the existing retry endpoint. EPUB conversion and AniList login remain outside this API.

## Error behavior

| HTTP | Typical codes                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ |
| 400  | VALIDATION_ERROR, INVALID_STATE payload validation                                               |
| 401  | UNAUTHORIZED                                                                                     |
| 403  | FORBIDDEN (origin)                                                                               |
| 404  | NOT_FOUND, MANGA_NOT_INDEXED                                                                     |
| 409  | SERVICE_NOT_CONFIGURED, INVALID_STATE                                                            |
| 413  | PAYLOAD_TOO_LARGE                                                                                |
| 415  | CONTENT_TYPE                                                                                     |
| 429  | RATE_LIMITED (login)                                                                             |
| 502  | UPSTREAM_TIMEOUT, UPSTREAM_HTTP_ERROR, SUWAYOMI_GRAPHQL_ERROR, ARR_GRAB_ERROR, KAVITA_SCAN_ERROR |
| 500  | INTERNAL_ERROR without credential/upstream body exposure                                         |

Stream HTTP status is already committed after opening; later errors are named SSE events. Per-provider failures are reported inside successful search responses. Batch errors persist as safe codes and require explicit retry. Never assume HTTP 200 means every external service succeeded.
