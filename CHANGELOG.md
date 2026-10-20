# Changelog

## Unreleased

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
