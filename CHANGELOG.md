# Changelog

## Unreleased

- `docker-compose.yml` now runs KaviSeerr alone against an existing Suwayomi and Kavita (with `.env.example`); the bundled Suwayomi + FlareSolverr stack moved to `docker-compose.full.yml`. README rewritten around a first launch.
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
