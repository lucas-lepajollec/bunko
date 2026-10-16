# Changelog

## Unreleased

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
- Backend: discovery and title sheets (AniList, MangaDex→AniList, MangaUpdates, Suwayomi), reading formats and origins, doujinshi/adult filtering and relevance ranking, automatic source matching stream, service status, library v2 (statuses, Kavita reading progress, imported-chapter ledger), source preferences and health, source filters and browsing, durable update feed with scheduling, downloader controls.
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
