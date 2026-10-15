# Verification — 2026-10-15

## Scope

API, multilingual interface and Docker packaging. No private-service login, real extension installation or real media download was performed. Docker browser login is verified (see Interface checks); the container smoke test (`scripts/container-smoke.sh`) runs in CI.

## Local checks

- `npm run check`: ESLint, strict TypeScript, **98 tests**, Next.js production build.
- `npm audit --omit=dev --audit-level=high`: **zero reported vulnerabilities** after upgrading `adm-zip` to 0.6.1. The initially selected 0.5.16 was replaced before delivery.
- `docker compose config --quiet`: valid three-service configuration.
- Application image builds on `node:22.23.1-bookworm-slim`, runs as UID 1000 with read-only root, writable named data/library volumes and a working healthcheck. Tested on Linux amd64; multi-architecture publication is not claimed.

Tests exercise encrypted/redacted settings, bearer/session/origin checks, request validation, FTS quoting/upserts, LongString source preservation, provider parsing and degradation, aliases/types/conflicting IDs, named SSE events, chapter normalization and special handling, real CBZ metadata insertion, Sonarr/Prowlarr search/grab routing, extension input shape, confirmed-download semantics, scan failure/retry without duplicate import, explicit queue failure, timeout handling and image-proxy boundaries. Data and credentials in tests are synthetic and temporary.

## Docker protocol smoke

The disposable `kaviseerr-smoke` Compose project uses actual pinned Suwayomi `v2.4.2366` and FlareSolverr `v3.5.2`, plus the built application. `scripts/docker-smoke.mjs` runs inside the app container; its generated test access token is never printed. It checks health, missing auth, session login, origin rejection, settings, sources, extensions, downloads, tracked media, extension refresh, settings application to actual GraphQL, input errors, absent Arr configuration, finite search/sync SSE, continuous download SSE and a real public metadata search.

The initial live `Yotsuba` manga query returned **53 deduplicated results** across AniList, MangaDex and MangaUpdates plus an empty local catalog. Observed provider durations were approximately 264 ms, 570 ms, 845 ms and 2 ms respectively. These are a single observation, not a latency guarantee or a representative local-FTS benchmark. No production API response is seeded with those results.

The final rebuilt-image smoke passed again with 53 results (observed provider durations 215/136/899/2 ms). The disposable test containers, network and volumes were removed afterward; the locally built image is retained.

To reproduce after creating an isolated stack:

```sh
docker compose -p kaviseerr-smoke up -d --build
docker compose -p kaviseerr-smoke exec -T kaviseerr node --input-type=module < scripts/docker-smoke.mjs
# Remove only this disposable project's containers, network and generated test data:
docker compose -p kaviseerr-smoke down -v
```

Real private Kavita scans and Sonarr/Prowlarr grabs, source-dependent downloads and Cloudflare behavior remain unverified until the operator connects those services and chooses extensions. The API reports missing configuration; the tests do not pretend those services exist. The frontend handoff documents these limits.


## Interface checks (2026-10-15, Claude)

The interface was rebuilt from scratch. The shared contract in `src/types/shared.ts` was written first; API and interface were then implemented against it.

- `npm run check` passes: ESLint with zero warnings, strict TypeScript, 98 tests (API fixtures plus the i18n parity test), optimized production build.
- Chromium screenshots at 1440×900 and 390×844 for every page (home, catalog, search, title, library, new chapters, downloads, sources, settings), with no page wider than the viewport and no JavaScript errors. Real public AniList/MangaDex/MangaUpdates data was used; no runtime demo data.
- The title-page chapter flow (automatic matching across two sources, doubtful candidate, merged variants, range selection, bulk action bar) was checked on desktop and mobile with browser-only intercepted fixtures; no request reached a real source and nothing was downloaded.
- Docker: image rebuilt, isolated `kaviseerr-qa` stack healthy with real pinned Suwayomi. Real browser login succeeded at `http://localhost:2512` and `http://127.0.0.1:2512`; a cross-site login POST returned 403 and a wrong token 401. English interface checked against the live container. The stack and its volumes were removed afterwards.

Not verified: a real Suwayomi with installed extensions, real chapter downloads/imports, a real Kavita instance (scan and reading progress), and Cloudflare-protected sources. These need the operator's own services and extension choices.
