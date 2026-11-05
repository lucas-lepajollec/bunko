# Changelog

## Unreleased

- Sonarr interactive search, like Sonarr's own buttons: a whole season or one episode (episode
  list with absolute numbers and what is already on disk). Anime batches ("01-12") count as season
  packs, so they show with "full seasons only".
- Extension health: the source list read from `health.json` is bounded (200 sources, short names).
- qBittorrent ≥ 5.2: an API key (`qbt_…`, Preferences → WebUI → API Key) can replace the login.
- Interactive searches wait up to 10 minutes (the browser gave up after 30 s) and show the time
  elapsed; closing the window stops them.
- A season search from a work's sheet shows full-season releases; single episodes on demand.
- Prowlarr: all categories by default (a category menu narrows it); TV searches include the anime
  category, which many anime indexers use alone.
- The Sonarr/Radarr and Prowlarr tabs keep their own results when switching between them.
- Downloads of series, anime and films are chosen by hand, never searched automatically: the
  Download button (or "Complete (n/m)" when part of it is on disk) opens an interactive search.
  The Sonarr/Radarr tab lists their releases for a season or the film (quality, languages, full
  season or episodes, size, seeders, indexer, age, and why Sonarr/Radarr would not pick it
  themselves); the Prowlarr tab searches the indexers by name, with the work's names suggested,
  for releases Sonarr/Radarr miss. Each release is sent with one click; the window stays open.
  Works are added to Sonarr/Radarr unmonitored and without any search.
- Downloads page: a "Series & films" section follows what was sent (Sonarr/Radarr queues and
  qBittorrent: progress, speed, time left, failures).
- Settings: Prowlarr and qBittorrent (read-only use of the torrent list) next to Sonarr/Radarr.
- Reading works: "Download the series" when nothing is owned yet, "Complete the series" once part
  of it is.
- Downloads for series, anime and films through Sonarr and Radarr (Settings → Sonarr & Radarr):
  a work's sheet gets a Download button that adds it with the chosen quality profile and folder
  (anime as Sonarr's anime type, in their own folder if set) and starts the search; the sheet then
  shows "waiting for a release", "complete (3/24)", the download's progress from the queue (as the
  download client, e.g. qBittorrent, reports it) or "downloaded". Anime are found through the
  offline id map (TVDB, TMDB for anime films), series through TMDB's TVDB id.
  `GET/POST /api/arr/request`, `GET /api/arr/options`; `RADARR_URL` / `RADARR_API_KEY` seed the
  first account like the other services.
- Player: subtitles sit a little above the bottom edge.
- "If you liked" posters no longer lose their top when they lift on hover.
- Same side margins on every page: the page keeps the scrollbar's room (`scrollbar-gutter`), so
  content no longer shifts between short and long pages; the header and the home hero are placed
  from the page width instead of `100vw` (they sat half a scrollbar off the content); a work's
  settings page uses the common width.
- Library toolbar on phones: selection (icon only), status and sort stay on one row, scrolling
  sideways if needed.
- Library selection mode: select works one by one or all shown ones (filters apply), then mark them
  read/watched, change their status, add or remove favorites, or remove them from the library.
  Removing, finishing and status changes ask for confirmation; removed works are not brought back
  by Kavita or Jellyfin imports. `POST /api/tracked/bulk`.
- TraDoc: a book Bunko can list but not read (library permissions) is now reported as such
  (`FILE_UNREADABLE`) instead of "TraDoc unreachable"; failed TraDoc requests log their underlying
  reason (`[bunko] tradoc request failed: ECONNREFUSED`…).
- TraDoc translations get their own worker lane: an upload no longer waits behind the Kavita
  index or a long release check, and running jobs are followed while the rest of the cycle works.
  A retried failure (TraDoc unreachable or too slow) is now shown on the job instead of an
  endless "waiting to be sent", logged as `[bunko] translation <id> <state>: <code>`, and waits
  its retry delay; "Run now" in the activity panel retries at once.
- Home and profile subtitles follow the universe: reading or watching words for "Pick up where
  you left off" and the weekly top, "episode by episode" or "newest first" for episodes and films.
  The catalog's release view says "Latest releases" in a mixed universe with video.
- The "In library" badge keeps only its check mark on narrow posters (phones, dense grids).
- The kinds menu: the "Everything" tile is the size of its content again.
- The activity panel scrolls inside itself on phones and stays above the tab bar.
- Planning on phones: the current day's ring is no longer cut at the top and bottom.
- Signing in reloads the page, so nothing a previous account loaded in this tab stays in memory.
- Extension streams resume where they stopped, on any device of the account (saved every 15 s,
  on pause and on close; forgotten once 90 % is watched). Jellyfin keeps its own place.
- Full screen on iPhone: the video's own full screen (iOS has none for page elements), the
  prefixed one on older Safari; phones turn to landscape where the browser allows it.
- The kinds menu highlights the whole "Everything" tile; the "Film" pill on release cards is only
  shown in mixed views, not in a films-only universe.
- Streaming extensions that know titles by TMDB id are asked with `tmdb:` ids: series and films
  (also when Bunko has no IMDb id for them) and anime, with the TMDB season from the anime map
  (asked before IMDb, whose season is TVDB's; no guess when the map has none).
- Streams on a service allowed on the local network (`BUNKO_VIDEO_ALLOWED_HOSTS`) start through
  the relay directly instead of a failed browser attempt first.
- Version labels are read line by line: "VO" followed by a count of French subtitle files is no
  longer taken for VOSTFR, nor a VF stream with the same mention.
- Streaming security: every address a streaming extension chooses (manifests, stream and subtitle
  lists, relayed streams, HLS playlists, segments, keys, subtitle files) goes through one guarded
  client. Private, loopback, link-local/metadata, CGNAT, multicast and reserved destinations are
  refused (IPv4, IPv6, IPv4-in-IPv6, odd spellings), checked at connection time against the DNS
  answer actually used (no rebinding) and again on every redirect, which also drops credentials
  when leaving the origin. Timeouts, size caps and per-account/server relay limits. Self-hosted
  extensions on the LAN are allowed by the administrator only (`BUNKO_VIDEO_ALLOWED_HOSTS`).
- Relayed bytes are served as opaque media with `nosniff` and a sandbox CSP (a hostile source
  could previously get an HTML page served from Bunko's origin). Native HLS players asking for a
  byte range of a playlist now get it rewritten (relayed HLS failed in Chromium).
- Streaming: a stream without a picture after 20 s counts as failed and the next one is tried; the
  final message says why (unreachable, unsupported, timeout). Versions VOSTFR / VF / MULTI / VO /
  other language / unknown, presented as read from the names; VO streams with subtitles in the
  interface language rank right after the preferred versions and start with them on; other
  languages start by themselves only if allowed (new setting). A failing extension rests (30 s up
  to 10 min); episode lookups are reused for 10 minutes; the next episode's sources are looked up
  at 90 %. Playback timings in the server log (`source_discovery_ms`, `time_to_first_frame_ms`,
  `stream_fallback_count`, `stream_error_type`). See docs/video-streaming.md.

- Streaming extensions (Stremio addons) play like a library: the best stream starts by itself
  and the next one is tried when the browser cannot play it. Streams are ranked by version in
  the interface language — subtitled original first, or dubbed first (Settings → Extensions →
  Streaming) — then by what browsers decode (1080p before 4K/HEVC). Labels show VOSTFR / VF /
  MULTI (or SUB / DUB in English) and the quality; torrent streams are folded away (they need a
  debrid service configured in the addon, which then returns direct links).
- Streams play through Bunko when the browser cannot load them itself: request headers asked
  by the addon, plain HTTP on an HTTPS page, HLS without CORS. Relay links are sealed per
  account and expire; HLS playlists are rewritten so every segment, key and rendition follows.
- Subtitle extensions: addons offering subtitles are asked for each episode, and subtitles that
  come with a stream are kept. SRT and ASS/SSA (gzipped or Latin-1 too) are converted to WebVTT;
  a stream in another language turns on subtitles in the interface language by default.
- Addon addresses often hold account keys: they are stored encrypted and never sent to the
  browser (the list shows the host and the addon's name). `stremio://` install links are
  accepted; an address that does not answer with a manifest is refused instead of stored.

- Extensions page by provider: Reading (Suwayomi extensions, for manga, manhwa, manhua and comics)
  and Streaming (Stremio addons, for anime, series and films), each saying which kinds it serves.
  The universe on screen opens its provider; the page no longer disappears in a video universe.
  Settings → Extensions summarises both providers (the "Video & streaming" section moved there).

- Background tasks named after what they do and grouped by the service they work with
  (Suwayomi, Kavita, Jellyfin, Catalogs, TraDoc, Bunko), with a description of each. "Anime
  works" only grouped anime seasons while linking imported works to the catalog was hidden in
  the Jellyfin sync: both are now one "Catalog linking" job for series, films and anime.
- Desktop kind menu opens on click like any menu, with "Everything" as its own column beside
  the reading and video kinds.
- The mixed home's Top 10 is the "Everything" mix: every enabled kind, in priority order
  (it was AniList manga only).

- Release check and cover pass (NAS profile: 95 % of their CPU): reading one work after a write
  scanned every stored release (up to 30,000 rows) and rebuilt the work each time it was read.
  Releases are now found by indexed identity and a work read since the last write is reused:
  48 ms → 0.4 ms per work on a 3,000-work library with 20,000 releases (scale test guard).
- Translations: an install interrupted after the file was written resumes safely — the backup
  of the original is made once and never from the translated file, and a separate copy is
  rewritten instead of duplicated. A book TraDoc reports finished as soon as it is sent is
  installed (it was marked completed without its file).
- TraDoc address: the service address (http://nas:2507) works as well as …/api/v1; an address
  that answers with a web page and a refused request (no model) get clear messages. Books are
  sent from disk instead of being read whole into memory.
- Jellyfin: a user name that does not exist is an error instead of silently reading another
  account (an empty name still uses an administrator).
- TMDB series releases: shows are looked up four at a time within an 8 s budget, followed shows
  first, instead of one after another.
- Catalog tracking flags: the library is listed and indexed once per response (it was twice).

- Kind priority: Settings → Media types lists every kind in order, with arrows to move one up or
  down and a box to show it. The order sets the universe switcher, the kind menus of the
  catalog, planning and library, the home shelves and the mix in "Everything".
- Balanced "Everything" catalog: one lane per enabled kind (AniList reading kinds, anime with
  their films in the same request, TMDB series and films, web novels, novels, books, comics),
  dealt kind by kind in priority order; kinds turned off are left out. It used to hold AniList
  manga only next to four text and comic lanes.
- The mixed home shows the week's series episodes and film releases when series or films are
  enabled and TMDB is set up.

- Background tasks in the activity panel: every job of the account (release check, catalog
  releases, source matching, Kavita scan, Jellyfin sync, anime catalog matching, covers,
  translations) with its last run, failures, waiting work and next run, and a button to run it
  now. Jobs appear only when they apply (service connected, kind enabled). One registry
  (`src/lib/background-jobs.ts`) defines them; `GET/POST /api/jobs` serves it.

- Settings: turning a media kind off no longer fails with "invalid values" (the list of kinds was
  capped at 9 since kinds were added; the cap now follows the kind registry, and a test enables
  every kind at once).
- Settings grouped by what they are about: You (account, media types), Administration, Services
  (Suwayomi, Kavita, Jellyfin, Translation — each with its connection and its options together)
  and Content (catalogs, streaming). Earlier links keep working. The static "Modules" cards are
  gone; each service shows its state in the list.
- Phone menu: a bottom sheet with the account, grouped rows with icons and sign-out apart.

- Live streams (activity, imports) no longer crash the process when the browser leaves between
  two writes (`Invalid state: Controller is already closed`).
- AniList priority: background jobs keep to one request every 2.5 s and stop when 30 requests
  remain in the window, so imports and release checks can no longer make the catalog
  unavailable.

- Hotspots found on a real NAS through the job telemetry:
  - **Release check (update-check)**: download history read once per check instead of once per
    work; seen/imported chapters and Kavita numbers looked up in sets instead of scanned for every
    chapter; unchanged observed chapters and release counts are no longer rewritten (each rewrite
    fired the version triggers and invalidated every view).
  - **Covers**: an already stored cover with nothing to send to Kavita only checks that its file
    exists, without reading the image; repeated failures back off (5 minutes doubling up to a
    day) whatever the candidates.
  - **Jellyfin**: between syncs, import runs only while series remain; catalog upgrades run once
    per sync; matching tries the work's own AniList id before decoding its seasons; watched
    progress is reapplied only when the index or the library changed.
- Automatic profiling: when the process stays at 80 % CPU or more, Bunko samples itself for 15 s
  (at most every 30 minutes) and logs the hottest compiled positions (`[bunko] profile …`).
  `scripts/perf/map-profile.mjs` maps them to source files from the same build.
  `BUNKO_PROFILE=off` disables it.

- Release ingestion no longer rebuilds the release → work resolver (decoding the whole library
  and catalog cache) for every resolved series. The resolver is reused while identities and the
  catalog cache are unchanged: a full ingestion with 5,000 works went from 25.5 s to 1.9 s of
  CPU, with no window above 50 %.
- Background work telemetry: each worker lane, release ingestion and request is measured.
  `GET /api/admin/jobs` (administrators) lists CPU and duration per job. Logs show
  `[bunko] job …` for runs above 2 s of CPU and `[bunko] busy: N% CPU over 10 s; running: …`
  when the process is busy, naming what runs. Aggregates only, no titles or settings.

- Kind registry (`src/domain/kinds.ts`): one description of every kind of work (family,
  formats, search type, catalog and release sources, unit, reading sources, dated releases).
  Lists, menus, validation, classification, worker lanes and pages derive from it. A coverage
  test fails when a kind lacks texts, a format belongs to zero or two kinds, or a kind is not
  accepted everywhere. Server and browser share one classification rule.
- Scalability: idle CPU with 5,000 works went from 59–117 % of a core to 0.3 %. Causes and fixes:
  - the 18+/identity graph has its own version domain and is skipped without manual 18+
    decisions;
  - reading or adding one work uses point queries;
  - the Jellyfin index is decoded once per sync with lookup maps;
  - identity queries use the index;
  - covers with nothing to fetch back off up to a day;
  - unchanged cover results are not rewritten;
  - source matching only runs with Suwayomi configured.

  Adding a work is constant time (about 20 ms instead of 160 ms and growing). New
  `tests/scale.test.ts`, `npm run perf:load` with budgets, and `docs/performance.md`.

- Film sheets: "Mark as watched" instead of "Episode 1 watched", no episode progress or counts,
  a compact watch card (no empty frame without a still, no stray checkbox).
- TMDB sheets show directors (films) or creators (series), the main cast and the English
  synopsis when none exists in the interface language.
- Works imported from Jellyfin before they could be identified (no TMDB key yet, id map not
  loaded) become their catalog work automatically: same entry, progress and Jellyfin link kept.
- Work settings search: a video work searches anime, TMDB series and films whatever the kind on
  screen, video results first, every other kind below.
- Series, films and animated films homes show their latest releases.

- Subtitles no longer show twice: Jellyfin is always asked not to burn subtitles (except image
  subtitles chosen in the player) and the text track is drawn once by the browser.
- Jellyfin libraries can be "Animated films" (detected for a films library named Animation /
  Anime), indexed, imported and matched like films.
- A video work linked to a sheet of another video kind keeps its kind (e.g. Arcane kept as anime
  but linked to the TMDB series); work validation accepts series, films, animated films and
  TMDB. TMDB sheets are catalog sheets (no "not in the catalog" banner, which is also aligned).
- Films (live action or animated) show one large "Watch" card with the film's banner, runtime
  and a watched tick, instead of an episode grid.
- Series and films get latest releases and planning: followed series episode by episode, shows
  on the air, and the week's film releases (live action and animated apart), in the catalog
  ("Latest episodes" / "Latest releases"), on their homes and in the planning.

- Player: playback was reopened (new Jellyfin session and transcode) every time the page
  refreshed in the background; it now opens once per episode and stream choice (verified against
  a real Jellyfin: 1 playback request instead of 5 in 25 s).
- Animated films are their own kind: anime films (AniList) and western animated films (TMDB),
  interleaved; the anime kind keeps series and OVAs, the films kind keeps live action.
- Kind lists saved before series, films and animated films existed now include them; Jellyfin
  series and films libraries are imported into the library (TMDB works by TMDB id when the key is
  set, otherwise the Jellyfin item), and the import progress counts them.
- Opening a later season shows a skeleton and moves to the whole work at once (manual links and
  the offline id map are used before any AniList request). Joining works refreshes both sheets
  immediately, so the joined part appears next to the seasons.
- Episodes without their own still use the work's banner with the episode number. The activity
  spinner sits at the bell's top-left corner.

- Series and films (TMDB): two new universes with catalog (trending, popular, best rated,
  newest), search (series and films also appear in the everything search, e.g. western
  animation), sheets with seasons and episodes (or one part for a film), film sagas, and the home
  of each universe. Japanese animation stays on AniList. TMDB key is a shared catalog credential
  (Settings → Catalogs, or TMDB_API_KEY). Series and films play from Jellyfin (series and films
  libraries, matched by TMDB id) or video extensions (IMDb id, season, episode).
- Work links: join another anime into a work by hand (e.g. a sequel series AniList keeps apart, a
  film series): it becomes a named part of the sheet, the library merges it and lists stop
  showing it separately. Anime season grouping also uses TMDB ids from the offline map.
- Jellyfin playback fixed for transcoded episodes (dashed item ids in Jellyfin's transcoding
  URLs were rejected by the proxy), retries as a transcode when the browser cannot play the
  original file, Jellyfin's subtitle preferences apply, VOSTFR by default (subtitles in the
  interface language when the audio is another language), subtitles sit above the controls.
  Verified against a real Jellyfin 10.10 (H.264 direct play; HEVC 10-bit + FLAC + ASS transcode).
- Episodes are a grid of cards (still, number, state, watched tick, play on hover) scrolling
  inside the panel. "Same universe" rows get scroll arrows. Top 10 titles align under their
  covers and show anime works. Library sorts by release/air date by default. Planning lists
  far more airing anime (up to 400 schedules a week). Home anime releases lead to the catalog's
  latest episodes. The activity spinner is centred on the bell.

- Activity center: the header bell is the one place for background work — downloads, source
  search, release checks, Jellyfin import, translations, Kavita reading, source scans on the page —
  each with its progress (percent and done/total), plus page loads and partial results. A small
  spinner sits on the bell while anything runs; the panel fits phones and closes on outside
  click. The header pill, the library activity line and inline loading notices are gone.
- Jellyfin playback works like jellyfin-web: the browser's device profile and an explicit
  bitrate go to PlaybackInfo; Jellyfin answers direct play (original file, seekable through the
  proxy) or its own transcoding URL. Quality presets follow jellyfin-web (max by default);
  audio, burned subtitles and quality reopen from the current position; text subtitles switch
  in place.
- AniList: one shared rate limiter (429 / Retry-After / X-RateLimit headers, spacing when few
  requests remain; requests that would wait too long fail fast to cached data), batched season
  loads shared between concurrent requests, stable airing cache windows, anime hero banners
  looked up as anime, and anime views no longer start reading-release ingestion. Background
  release checks and anime work run only for enabled kinds.
- Anime seasons are grouped in the catalog, search and work settings; the work's own seasons no
  longer appear in its relations or recommendations. Catalog search uses the media type of the
  universe on screen. The anime catalog gets a "Latest episodes" view (week by week).
- Work settings: catalog results show the work's kind (and the selected universe) first, then
  other kinds; anime texts speak of Jellyfin, and an anime can leave the catalog for its
  Jellyfin series.
- Library sorts: release/air date, rating, popularity and most left to read/watch.

- Jellyfin works on its own worker lane: an account with only Jellyfin is no longer skipped by the
  worker, the index and import no longer wait behind release checks, an unfinished import
  continues every minute, and saving Jellyfin settings starts it at once. Series identified by
  their ids are imported straight from the batched AniList load (no per-work request).
- Library: the header shows the works of the selected kind next to the total, and each kind chip
  shows its count.

- Video player: every aired episode has a play button, and "Watch S2 · Ep. 5" resumes where the
  work stopped. Jellyfin episodes play inside Bunko through a server proxy (the API key stays on
  the server) with Jellyfin's audio tracks, subtitles (text as WebVTT, image ones burned in) and
  quality ceilings; the position is saved in Jellyfin for resume and past 90 % the episode is
  marked played in Jellyfin and watched in Bunko. Next episode, keyboard shortcuts, full screen.
- Video extensions (Settings → Video & streaming): Stremio-protocol addons added by manifest URL;
  episodes are looked up by Kitsu, IMDb or MyAnimeList ids from the offline id map, streams in the
  interface language come first, direct and HLS streams play in Bunko (torrents are listed as not
  playable in a browser). Bunko ships no addon.

- Jellyfin import uses the ids Jellyfin already has (TVDB, TMDB, IMDb, AniDB, AniList plugin)
  through an offline anime id map (Fribb/anime-lists, shared, refreshed weekly) and loads AniList
  entries 50 per request: a whole library imports in a few requests. Title search remains only
  for series nothing identifies. Works also load all their seasons in one batched request.
- Phones: Activity moves from the tab bar to the menu (with its count). Anime sheets show an
  episode skeleton while loading instead of the novels notice, and a later season known to belong
  to a work opens the work immediately.

- Jellyfin import shows its progress in the header activity ("Adding Jellyfin anime… 35/120")
  and runs a batch every minute. Settings → Jellyfin → "Disconnect Jellyfin" forgets the server
  and can remove the works it added (works followed by hand stay).

- Anime are whole works: the TV seasons linked on AniList (sequel/prequel) form one sheet with a
  season picker, progress counts episodes across seasons, and opening a later season opens its
  work on that season. Following a season follows its work; entries followed per season before are
  regrouped by the worker (progress converted, duplicates merged). Latest releases and the
  planning show the work with "S2 · Ep. 5".
- Jellyfin import works like Kavita: every series of the anime libraries is followed — the
  catalog work when the AniList plugin id or one clear title match identifies it, otherwise the
  Jellyfin series itself (off-catalog, with its poster). Batches continue every two minutes until
  done; removed works are not re-added. Watched episodes count across seasons.

- Jellyfin libraries get a role (anime, series, films, ignore), detected from the library type and
  name and editable in Settings → Connections; only anime libraries feed anime sheets and automatic
  following, and the Jellyfin AniList plugin id is used directly when present. Changing roles or
  the watching user re-reads Jellyfin.
- Sources can be searched and chosen for a work outside the library (Settings of the work →
  Sources); following it later keeps them.
- General page status (still loading, some providers unreachable) moves to a bell in the header
  instead of interrupting pages.
- The library follows the kind on screen: anime use watching statuses, "new episodes" and "last
  watched" sorts, "watched N" on cards, and hide reading-only tabs. The home says "Continue
  watching" for anime. Hero banners: a capped, gentle zoom with a long soft fade, no blurred copy.

- Jellyfin: connect it in Settings → Connections (address, API key, the user whose watched state
  counts). Bunko indexes series and episodes every 15 minutes (or on demand), links anime by the
  AniList id (Jellyfin AniList plugin) or by title, picks the season from titles like "Season 2",
  shows owned episodes and "Open/Play in Jellyfin" on anime sheets, moves watched progress forward
  and can follow Jellyfin anime automatically when AniList recognises them clearly. The anime's
  settings get a Jellyfin tab to choose the series and season or keep it unlinked (schema v18).
- The universe switcher looks like the other header links and opens a two-group panel (reading,
  video) with a short description per kind. Wide banners keep their own proportions over a soft
  blurred fill instead of being stretched (no more zoomed, blurry heroes).

- Universes: a switcher in the header (hover) and in the phone bottom bar narrows the whole
  interface to one kind (manga, manhwa, manhua, comics, light/web novels, novels, books or anime)
  and loads only it: home, catalog, planning, search and source pages follow it; the library opens
  on it and keeps every kind one tap away; sheets stay reachable. Settings → Account chooses the
  universes offered and whether "Everything" (all together, with kind menus) is one of them.
- Releases and planning show official catalog releases only; chapters seen on linked sources are
  library news, never release dates. The home gets a "Latest episodes" shelf for anime.
- Tag picker: wider, a clear search field, tags in the interface language where a translation
  exists, sorted alphabetically; genres sorted too. Opening a menu closes any other one.

- Anime, phase 1: an Anime kind in the catalog, library and planning (AniList). Anime sheets list
  episodes with titles and stills, the next airing date, studio and duration, and keep the place
  by hand ("Watched episode N", tick an episode to mark everything up to it). The planning adds
  the week's airing episodes of followed anime and popular shows. The universe now links manga,
  novels and anime both ways. No player yet.

- The catalog shows its filters as a visible row on every screen: genre, AniList tags (with
  search; demographics are tags), status, year, season and minimum score, offered only where the
  selected kind supports them. With 18+ shown, 18+ genres and tags and an "18+ only" switch are
  added. Open Library covers load the medium size for faster cards.

- Admins choose what each member may do (connections, extensions, downloads, translation, 18+).
  With 18+ off, extensions marked 18+ are hidden everywhere by default (an account option keeps
  them). Reading progress comes from Suwayomi by default, or Kavita, chosen in Settings; finished
  chapters are marked read in Suwayomi. Account recovery requires a one-time code from the data
  folder; login limits apply per account only. Changing the Kavita or Suwayomi server forgets the
  old server's identifiers. Title-only release matches no longer spread 18+ decisions. Next 16.4.3.

- Volume mode hides boxes on owned volumes and "select all" counts missing volumes; the chapter
  list loads more rows as it scrolls instead of a counter. Loading notices no longer flash and
  move the sheet during background refreshes. "Refresh from Kavita" rescans a work's folder now.
  Same-name catalog ties are broken by owned volume/chapter counts, and unlinked works point to
  the catalog link. The work settings page is wider with a side menu on desktop. The header
  search filters the library and the planning in place (`?q=`). The planning and the home shelves
  show one card per work per day with a chapter range instead of every chapter of a bulk upload.
  Covers retry temporary failures and load four at a time. Latest releases link to the planning.

- Translate owned books, light novels and web novels through a TraDoc instance: connect it in
  Settings → Connections, then choose files, languages, model and result on the work's sheet.
  Either replace the file (Bunko keeps the original outside the library and can restore it) or
  keep both as a separate series. Jobs survive restarts, retry while TraDoc is unreachable and
  rescan Kavita when the translation is installed.

- Audit fixes: automatic downloads now follow the work's current settings when a check returns
  (and a refused lot no longer erases the detected chapters); an update check that exceeds its
  source budget completes instead of rerunning every half minute; download control reads one lot
  instead of the whole history ten times a second. Imported archives are readable by a Kavita
  running under another user. Suwayomi's own download flag no longer hides chapters missing from
  the library. Changing a work's catalog identity keeps its reading position and local chapters.
  Removing every source by hand is respected by background matching (an explicit search still
  links). Browser caches never carry one account's data into another session, and the content
  filter no longer stops caching. Search opens again between 1024 and 1279 px; hidden reader
  controls leave the keyboard order; failed sync/sign-out/key removal and no-op downloads are
  reported; source edits wait for the previous save; books get the Kavita section of their
  settings.

- Gather everything that changes how Bunko treats a work on its own settings page, linked under
  the work's details: chapter or volume unit (with a suggestion when Kavita already holds whole
  volumes), the owned-files declaration, automatic downloads, 18+ classification, display title,
  catalog, sources, Kavita and images. The sheet follows the chosen unit: in volume mode missing
  items, selection and "complete the series" work on whole volumes, and recent chapters not yet in
  a volume stay in their own group. Add a "Search my sources" action that runs the automatic title
  search for a work, from its settings and from the sheet when no source is linked.

- Continue source-association batches while cover/index maintenance is still running, so the
  remaining library queue does not stop after the first two works. Keep pacing, account fairness
  and failure guards. Move source-less works into the library sort dropdown; show the bulk action
  only for that filtered view and submit precisely its current format/status/shelf selection.
- Show actual owned chapters and tomes in sheet summaries and library cards independently of the
  reading-progress unit, avoiding a false zero when only the other kind of file is present.
  Chapters covered by a known complete tome still display their existing Kavita availability.

- Keep likes inside the profile and redirect the former favorites page there. Align home shelf
  fades with the actual mobile scrolling edges and retain the first-card gutter when snapping.
- Prioritize explicit library source associations, persist confident results before slower source
  searches/counts, and start an initially empty matching lane during ongoing maintenance. Bound
  catalog/entry waits, retry transient failures and rotate exhausted extension lanes, preserving
  manual choices, source preferences and account isolation.

- Build release images once per architecture on parallel native amd64/arm64 runners, reuse
  architecture-specific CI caches and publish the exact smoke-tested digests without rebuilding.
  Preserve source checks, both native SQLite smoke tests, provenance/SBOM and recoverable tags.

- Keep catalog, library, planning and title navigation responsive on HTTP/1 LAN installs by
  limiting private artwork transfers to two, loading near the viewport and cancelling obsolete
  images on scroll/navigation. Cache Metron artwork privately on Bunko's origin, bound cover
  and JSON waits, and make every configured catalog category progressive. Failed catalog
  snapshots become partial results with paced recovery instead of endless loading placeholders.

- Refresh reader neighbours independently of cached pages, so newly downloaded chapters become available during reading; keep each chapter's own page, scroll and resume state when navigating. Avoid redundant progress/identity writes and defer next-chapter prefetch until the last three pages.

- Display search/catalog results and source chapters incrementally as each provider responds. Show owned rows immediately and retain selection/read/download actions while slower work continues. Open known-card sheets from their available metadata while details load; preserve content on errors and avoid perpetual failed-provider loading loops.

- Persist reliable automatic source matches for followed works directly from title discovery, refresh library/chapter state after completed scans, and request release updates when sources change. Retry transient matching failures after five minutes; language or extension changes requeue source-less works. Manual choices and dismissals remain authoritative.

- Show when search, title sheets and release feeds are still being completed, refresh pending data automatically and report partial source failures. Show the displayed/total chapter count and avoid premature empty or “complete series” claims.
- Correct misclassified owned files from a small button beside the existing chapter/tome switch, in tome view. Reuse chapter-style rows and reader actions for owned tomes, without additional counting menus or stock pills. Keep future chapter downloads separate, provide owned-volume reading with the correct progress unit, and make the declaration reversible. Library totals now distinguish chapters and tomes.

- Favor sources matching Bunko's interface language in live search and title source suggestions. Manual interface choices now reach fetch/SSE requests; matching title relevance still comes first, other selected languages remain available, and saved filters/links are preserved.

- Show BD/comic covers in catalog and search cards by resolving Metron issue artwork on demand, including previously cached series. Keep provider pacing and reuse the issue cache.
- Search Metron alternative names as well as primary names, and prevent a previous query's full results from masking the next query's fast results.

- Preserve reader completion when moving immediately to the next chapter, and flush intermediate positions on navigation or exit.
- Keep distinct catalog works with conflicting provider identities, creators or publication years instead of merging homonyms by title.
- Discover all formats across AniList, Open Library, MangaUpdates and configured Hardcover/Metron catalogs. Results arrive progressively, retain provider pagination and report partial outages.
- Classify cold web-novel pages in the background without waiting for every detail sheet; keep upstream pacing and require positive web-novel evidence.
- Write the downloaded source variant's language into ComicInfo, omitting unknown/multilingual values.

- Preserve existing CBZ files on import conflicts. New works receive separate stable folders, including homonyms; matching import fingerprints make interrupted publication retryable without replacement.
- Keep partial chapter imports separate from complete-volume ownership, so later chapters in the same tome are detected and downloaded.
- Scope chapter imports, archive pointers, jobs, observations and batches to their Suwayomi connection. Switching servers preserves local files/history, detaches obsolete numeric source links and blocks old batches from running against the replacement server.

- Catalog credentials are shared across accounts and managed by administrators; everyone can use configured catalogs while personal libraries, service connections and caches stay separate. Existing catalog credentials migrate once from the oldest administrator, without merging different users' keys.
- Metron accepts an API token without a username, with priority over the retained password connection. Settings include a direct token link and step-by-step Google Books key setup in all five interface languages.
- Shared catalog changes refresh each account's release feed on its next request, including when the regular twenty-minute refresh window has not elapsed.

- Downloaded chapters show up right after Kavita's scan; chapters you own only as files appear in the table and open in the reader; the table shows all chapters by default and folds the range picker.
- Sources: one shared request budget per Suwayomi server across accounts (interactive first), health no longer counts Bunko's own queue, stale "slow" states clear quickly; popular/latest requests match Suwayomi's own web UI and extension errors are reported in full.
- Matches: search sources with another name; choose whether Bunko's cover is pushed to Kavita. One "Read" button (Bunko reader, Kavita in its menu); status centered on phones; sign out in the phone menu.
- Downloads refresh their Kavita series immediately after scanning, including newly created series, with bounded polling and durable retry.
- Chapter lists include owned chapters missing from linked sources; the reader can open their local CBZs and retain page progress without Suwayomi.
- Accounts sharing a Suwayomi server share its request budget, with fair background scheduling and reserved interactive capacity. Slow/error health expires quickly and never blocks an interactive retry.
- Source browse follows the official WebUI request shape; sanitized extension errors retain their full explanation.
- Source matching accepts a custom search query and returns all scored hits. Kavita cover synchronization can be disabled per work and restored promptly.

- Matching scans your installed sources in your chosen source languages only (not every language variant), merges duplicates, and shows each result's language.
- Fixed: many sources showed "not found" and were skipped by search and matching because their extension carries a mature-content flag; sources are never hidden by the content filter anymore (it applies to works only).
- Settings → Catalogs: optional free keys for Google Books (new novels, books, comics, LN volumes), Metron (comics catalog and weekly issues), Rakuten Books (new Japanese LN volumes) and Hardcover (novel catalog), each with a Test button. Nothing changes without keys.
- Count a work in volumes (tomes) or chapters from its title sheet: progress, new releases, the chapter table and automatic downloads follow the choice (chapters of an owned volume are never downloaded again).
- New volumes and editions in the release feed from Google Books and the BnF catalog (novels, books, comics, light novels), shown as "Vol." cards on the home page, the feed and the planning.
- Web novels you follow on Royal Road get their new chapters from its RSS feed.
- Library formats follow your Kavita libraries: a series in the Kavita library chosen for novels (or books, LN, manga…) is classified as such, recomputed on every reindex and whenever library targets change; "Reindex now" always runs.
- Each account picks its media folder in Settings → Kavita libraries: `/library` or any subfolder, with any name; renaming an account never changes paths again. Existing setups are kept (the first account gets `/library` back when another account's old folder was blocking it).
- Fixed a home page crash after updating: cached responses are versioned, the home feed always has every row, an unavailable books catalog no longer breaks the page, the browser cache is tied to the build, and a recovery screen clears cached data instead of a blank error.
- Light novels, web novels, novels and books are now separate formats: novels and books come from Open Library (catalog, search, title sheets), LN/WN releases keep their own home rows; Kavita targets per format.
- A Kavita series can be linked to the right catalog work for good, and you can choose the name shown for any title (catalog, alternative titles, Kavita name, or your own).
- Source matching scans every installed source, not only the ones selected for global search.
- Catalog toolbar: formats, then view (catalog / latest chapters / new series), a folded Filters panel and sort on one line, with removable filter chips.
- Phones: a menu button for downloads, sources and settings; dropdowns close on a second tap. Home: the selected hero thumbnail is the largest; comics, LN and WN latest-release rows. Reader: arrow keys always go to the next/previous page.
- Built-in reader: read any chapter straight from your sources (or from your library files when already downloaded) in manga (right-to-left), left-to-right or webtoon mode, with next pages preloaded, resume where you stopped, and chapters marked read when finished. "Read" / "Resume" on every title and a read button on each chapter.
- Volumes: chapters carry their volume when sources give it; title sheets can show chapters grouped by volume and select a whole volume; downloads are named with the volume for Kavita.
- Comics & BD as a format: library filter, Kavita target, source search, reader. There is no public comics catalog, so the catalog points to your extensions.
- Faster: instant first search results (local and cached) refined when every provider answers, image cache housekeeping off the request path, incremental Kavita sync, a page frame instead of a blank screen while signing in, and priority loading for the first covers.
- Accounts can be renamed (by an administrator in Settings → Users, or by yourself in My account); you stay signed in. A `/library/<username>` mount must be renamed in the compose file too.
- Multi-user: every account is a separate Bunko instance with its own settings, Suwayomi and Kavita connections, library, downloads and content filter (administrators also manage accounts in Settings → Users). The existing installation becomes the first account unchanged — same session, same `/library` mount; additional accounts mount their Kavita folders under `/library/<username>`.
- Per-work content filter override from the title sheet, applied everywhere.
- Library: "All" and "Updates" tabs; reading statuses moved to a dropdown next to the sort.
- Settings show one section at a time on desktop too.
- Home hero uses the portrait cover on phones; opening a dropdown no longer hides the page scrollbar.
- API: per-work content filter overrides, matched across provider identities on every catalog and library surface.

- Fixed: followed series could disappear from the library because of source metadata. The content filter now relies on explicit ratings only, the library says how many titles it hides, and changing it refreshes every page.
- Fixed: a source's whole back catalogue showed up as "latest releases". Source releases use the chapter's real upload date; first sightings are never "new".
- Home: the weekly top 10 keeps its last good list instead of going blank, and the hero resolves catalog banners.
- Custom dropdowns everywhere (no white popups, no focus rectangles), no zoom on phone inputs, catalog no longer stuck empty on phones, settings open section by section on phones; "Language & display" section name.
- Faster warm responses for home, releases and planning.
- Chapter-by-chapter release feed (MangaUpdates + MangaDex + your sources) with release times: home hero, latest chapters per format on the home page, and a "Latest chapters" view in the catalog (50 at a time).
- New Planning page: the week Monday–Sunday with release times, actual releases for past days and the usual release day (estimated) for the coming ones; format filters and "My library only".
- Home: resume, weekly top 10 (all formats), latest chapters per format. Catalog keeps its default view and adds "Latest chapters" and "New series" switches; genres fit on one line and expand; filters on one line.
- Library updates moved into the Library page ("Updates" tab); the Updates page now redirects there. Planning replaces it in the navigation.
- Content filter in Settings → Language & display.
- Kavita scans work (the scan API needs the key in its body, from an admin account); Settings warn when the key is not an admin key, and title sheets say whether the cover reached Kavita.
- Downloads page lists every chapter with its own state, progress and error; one failing chapter no longer fails the series, failed chapters can be retried alone, and finished batches can be removed.
- Title sheets: cover and details on the left with the Matches button at the bottom, title and chapters on the right; the latest 15 chapters with "See more" and an inner scroll; "Select all" covers every chapter of the filter; 3-line synopsis.
- Feedback is calmer: temporary toasts at the bottom, ⓘ bubbles for minor caveats, clear notices above the chapters for real problems.
- Matches: Catalog, Sources and Kavita as three rows with a state each; automatic sources prefer the most relevant then the most complete (up to three); source search lists working sources first.
- Dark native dropdowns (Brave), chevrons off the edge, rounded focus rings; wider layout on large screens.
- Downloads no longer fail with "invalid values" when a title uses a cover served by Bunko; downloads and tracking take artwork from the server's own record.
- Much lower CPU: library reads aggregate in SQL and are memoized, SQLite runs in WAL mode, the worker wakes on events instead of every 1.5 s, and the update cycle no longer recomputes the whole library per title.
- Covers of followed titles are downloaded once and served by Bunko with long-lived caching, so they no longer reload or depend on sources being up.
- Lighter UI: download polling slows down when idle and large blur effects were replaced by gradients.
- Loaded data stays loaded: images from Kavita and sources are cached on disk, catalog metadata persists across restarts, the automatic cover is fixed once it works (and pushed to Kavita), and the browser keeps the last library and sheets between visits. Background activity no longer refetches whole pages.
- Title backgrounds show only the catalog work's own banner: none when there is no banner or the title is off-catalog, and they can be hidden per title (Matches → Images).
- A visible "Matches" button on every title; layouts checked from 360 px to desktop.
- Banner visibility choices persist per followed title and reset to automatic when changing its catalog identity.

- Kavita covers load on stable Kavita (the image API needs the key as a query parameter).
- Source matching runs continuously in the background instead of three titles per update cycle; progress shows in the header and the library, and cards say when sources are pending, being searched or not found ("To check" filter).
- Covers fall back automatically when an image fails; any cover from the live source scan can be chosen without linking that source.
- The Matches panel is reorganised in tabs (Work, Sources, Kavita, Cover) with a save status, and starts the source scan by itself.
- One "Matches" panel per title: catalog work (or off-catalog), sources with their latest chapter (scan all, reorder, remove wrong ones), Kavita series, and cover (automatic, or picked from the catalog, a source or Kavita).
- Followed titles without sources are matched to sources in the background; each source's latest chapter is refreshed for the whole library, so release counts stay current without opening a title.
- Kavita libraries: a format can be set to "no library"; manhua no longer falls back to the manga library.
- Renamed to **Bunko**, with its own logo and browser icon (old `KAVISEERR_*` variables and database still work).
- Kavita folders are mapped automatically through the single mounted folder; each format gets a suggested library, and downloads refuse to run without a target instead of landing in the mount root.
- The library mirrors Kavita: every Kavita series is followed automatically, matched to the catalog when possible (cover pushed to Kavita) or kept as an off-catalog entry with its Kavita cover.
- Wrong matches can be fixed from a title sheet (catalog work and Kavita series); the released chapter count uses the highest of catalog, sources and Kavita.
- Accounts: choose a username and password on first start (no more token sign-in), change it in Settings, reset with `BUNKO_RESET_ACCOUNT=true`. The bearer token remains for API clients.
- Bunko now downloads chapter pages from Suwayomi and builds Kavita-named CBZ files itself (no Suwayomi download queue or storage), with its own pausable download engine.
- Kavita libraries: choose a target library folder per format, index existing Kavita series, show what you already own, skip owned chapters, follow series already in Kavita.
- Sources: longer deadlines with a concurrency limit, and readable error reasons (Cloudflare, HTTP error, login required).
- Fix: the published image was missing the title-sheet and source-matching API routes.
- `docker-compose.yml` now runs Bunko alone against an existing Suwayomi and Kavita (with `.env.example`); the bundled Suwayomi + FlareSolverr stack moved to `docker-compose.full.yml`. README rewritten around a first launch.
- New interface ("Cinéma × Librairie"), rebuilt from scratch: home with featured hero, Top 10 and shelves; Catalog with type/genre/status/sort; two-level search with off-catalog source hits; source browsing with extension filters; title sheets with automatic French-source matching, source priorities, reading status, chapter table (missing/unread/ranges/versions) and bulk download; library shelves with read/owned/released progress; new-chapter feed; downloads with pipeline steps and engine controls; sources, extensions and repositories; settings with modules. Desktop and mobile.
- Interface in English, French, Spanish, German and Italian, with a key/placeholder parity test.
- Backend: discovery and title sheets (AniList, MangaDex→AniList, MangaUpdates, Suwayomi), reading formats and origins, doujinshi and content filtering and relevance ranking, automatic source matching stream, service status, library v2 (statuses, Kavita reading progress, imported-chapter ledger), source preferences and health, source filters and browsing, durable update feed with scheduling, downloader controls.
- Docker browser login fixed: Origin is compared with the incoming Host; cross-site requests stay rejected.

- French responsive interface: metadata poster search and quick search, tracked media, installed-source SSE search, merged chapter variants/ranges, live downloads, extension actions and editable integration settings.
- HttpOnly-session login, explicit saved-secret clearing, independent service errors, keyboard dialogs and reduced motion; real API data only.
- Frontend check passes with 26 tests. Docker browser acceptance remains blocked by the existing backend Origin comparison; no public release is claimed.

- Initial backend: SQLite/FTS5, cascade search, live FR source search and catalog synchronization.
- Suwayomi extension management, merged chapters, durable downloads and retryable Kavita CBZ imports/scans.
- Interactive Sonarr/Prowlarr release search and provider-correct grabs.
- Authenticated API, redacted/encrypted settings, tracked media and automatic chapter checks.
- Docker source stack and shared frontend contract.

No public release has been published. Version 0.1.0 identifies the initial local implementation.
