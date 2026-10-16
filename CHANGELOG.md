# Changelog

## Unreleased

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
