# Verification — current and historical evidence

## Comic artwork and search follow-up — 2026-10-18

- `npm run check`: lint, strict TypeScript, **540 tests / 40 files**, optimized production build; no warnings. Regression fixtures cover Metron series without image fields, authenticated cover redirects, shared issue-page lookup, warm-cache repair, credential replacement, hostile/mismatched artwork and cover retention without CDN auth forwarding. Search fixtures exercise eight formats through every enabled catalog adapter/local index, plus fast/full query changes.
- Local image `bunko:comic-cover-search` builds successfully; `scripts/container-smoke.sh` passes **111 checks**. This is a local validation image, not a new published GHCR release.
- Production-image browser QA uses tmpfs-only data/library, a synthetic administrator/token and synthetic upstream metadata. Eight cards load artwork through the actual protected redirect, using the public issue image from Metron's documented example. All eight load on desktop and mobile (390 × 844), no horizontal overflow or console errors. Alpha → Beta search shows only the new result. Temporary browser/container state removed.
- Provider coverage is verified by code and isolated protocol fixtures. Real NAS credentials, catalog contents and deployment are not accessed. Upstream matching pages remain bounded; publication-only providers and live extension search are separate integrations.

## Catalog/reader audit corrections — 2026-10-18

- Final `npm run check` exits 0 on Node 22.23.1: zero-warning ESLint, strict TypeScript, **534 tests / 39 files** and optimized production build without warnings. Source remained unchanged throughout the accepted run.

- New catalog/client regressions cover immediate completion and intermediate-exit flushing, serialized writes with one active retry, conservative provider identity/creator/year matching, transitive homonyms, slow/failed provider lanes, failed classification ending pending state, bounded cold aggregate waits, provider pagination, UTC midnight refresh, account cache isolation, progressive cold WN classification and actual archive language. An existing real CBZ import fixture now verifies English variant metadata despite a French linked source.
- Browser QA uses the production Docker image with disposable accounts/archives and synthetic catalog cache fixtures. Three page turns and chapter navigation in **575 ms** persist chapter 201 at page 2/3 and `last_read=1` (repeated on the final image at mobile width in **610 ms**); intermediate chapter-202 exit in **402 ms** persists page 1/3. Catalog All renders mixed formats and partial-outage feedback at desktop 1280 and mobile 390×844, with no horizontal overflow or console errors. The final image also passes a real pending-page browser check: a newly published synthetic book appears automatically without navigation/reload, the original result stays visible and all loading skeletons disappear. These are local observations, not provider/NAS performance claims.
- Final-source image `bunko:audit-fixes` builds; `scripts/container-smoke.sh bunko:audit-fixes` passes **111 checks**, including session/origin checks, private account layout, local reader pages/progress and imports/mount contracts. No image publication, real-provider login or NAS deployment is implied.
- Screenshots use explicitly synthetic offline works without cover artwork: [desktop](assets/audit-catalog-desktop.jpg), [mobile](assets/audit-catalog-mobile.jpg).

## P1 import integrity corrections — 2026-10-18

- Final `npm run check` exits 0 on Node 22.23.1: ESLint with zero warnings, strict TypeScript, **521 tests / 37 files**, optimized Next production build without warnings. Final run uses isolated temporary fixtures; no source changes during this run. No packaging/dependency changes, Docker smoke or real-provider/NAS acceptance in this slice.
- `tests/import-integrity.test.ts` adds nine regressions: concurrent same-title work imports, stable folder ownership despite deleted/reused tracked row IDs, conflict preservation and recovery after file publication without acknowledgement, incomplete volumes even after Kavita indexing, reused IDs/jobs/history across server switches with historical local reading, late connection changes during transfer, explicit Kavita folder choice/conflicting ownership, same-URL reused chapter IDs assigned to another work, and atomic/idempotent/rollback-safe v14 migration with archive provenance.
- Existing migration tests still cover copied pre-v9/v9 installations with 1,200 followed works, row/file/session preservation through restart and injected relocation interruption. Legacy folder/mount paths, partial-volume progress, scan polling, worker retry and source association fixtures are updated for the actual contracts.
- Three performance/profile fixtures retain 5,000 observations in the active source namespace, including 100 followed works and 30,000 release rows where applicable. Their cold-query-count and response bounds pass with the populated scoped ledger; a redundant settings lookup was removed from the snapshot path rather than raising the guard.
- Existing files and manual Kavita paths do not move. New folders use stable work suffixes. Conflicting destinations fail with translated `IMPORT_CONFLICT`; a changed/reused source identity fails with `SOURCE_CHANGED`. URL changes require source reassociation; full-volume ownership intentionally excludes unknown/partial archive evidence. Connection fingerprints are internal, redacted from public batch JSON.

## Shared catalogs correction — 2026-10-18

- Node 22.23.1, `npm run check`: lint, strict TypeScript, **512 tests across 36 files**, production build passed. A subsequent build passed without warnings after adding the existing Turbopack filesystem-tracing opt-out to the runtime migration path.
- New isolated fixtures verify shared encrypted credentials, admin-only writes/clears/probes, member catalog use without key/username disclosure, private service settings, token priority and failed-token behavior, credential rotation and warm cache identities, SQLite cross-connection edits/rollback, migration from the oldest admin without combining accounts, explicit clear/restart preservation and per-account publication refresh after shared edits. The existing route inventory now expects provider probes to require admin.
- Browser checked the built **standalone production server** with disposable storage and synthetic admin/member accounts. French settings at desktop width 1280 and mobile 390×844: token field, legacy password disclosure, all five Google Books steps, disabled probe while changes are unsaved, and member read-only availability. No horizontal overflow or browser console errors observed. Member catalog section has no credential fields or probe controls; switching accounts clears the prior view.
- Temporary browser tab/server/storage removed after QA. No real provider credentials, NAS services or media used. Actual provider authentication with operator keys and deployed NAS acceptance remain unverified; no deployment or image publication performed.

## Scope

API, multilingual interface and Docker packaging. No private-service login, real extension installation or real media download was performed. Docker browser login is verified (see Interface checks); the container smoke test (`scripts/container-smoke.sh`) runs in CI.

## Local checks

- `npm run check`: ESLint, strict TypeScript, **98 tests**, Next.js production build.
- `npm audit --omit=dev --audit-level=high`: **zero reported vulnerabilities** after upgrading `adm-zip` to 0.6.1. The initially selected 0.5.16 was replaced before delivery.
- `docker compose config --quiet`: valid three-service configuration.
- Application image builds on `node:22.23.1-bookworm-slim`, runs as UID 1000 with read-only root, writable named data/library volumes and a working healthcheck. Tested on Linux amd64; multi-architecture publication is not claimed.

Tests exercise encrypted/redacted settings, bearer/session/origin checks, request validation, FTS quoting/upserts, LongString source preservation, provider parsing and degradation, aliases/types/conflicting IDs, named SSE events, chapter normalization and special handling, real CBZ metadata insertion, Sonarr/Prowlarr search/grab routing, extension input shape, confirmed-download semantics, scan failure/retry without duplicate import, explicit queue failure, timeout handling and image-proxy boundaries. Data and credentials in tests are synthetic and temporary.

## Docker protocol smoke

The disposable `bunko-smoke` Compose project uses actual pinned Suwayomi `v2.4.2366` and FlareSolverr `v3.5.2`, plus the built application. `scripts/docker-smoke.mjs` runs inside the app container; its generated test access token is never printed. It checks health, missing auth, session login, origin rejection, settings, sources, extensions, downloads, tracked media, extension refresh, settings application to actual GraphQL, input errors, absent Arr configuration, finite search/sync SSE, continuous download SSE and a real public metadata search.

The initial live `Yotsuba` manga query returned **53 deduplicated results** across AniList, MangaDex and MangaUpdates plus an empty local catalog. Observed provider durations were approximately 264 ms, 570 ms, 845 ms and 2 ms respectively. These are a single observation, not a latency guarantee or a representative local-FTS benchmark. No production API response is seeded with those results.

The final rebuilt-image smoke passed again with 53 results (observed provider durations 215/136/899/2 ms). The disposable test containers, network and volumes were removed afterward; the locally built image is retained.

To reproduce after creating an isolated stack:

```sh
docker compose -f docker-compose.full.yml -p bunko-smoke up -d --build
docker compose -f docker-compose.full.yml -p bunko-smoke exec -T bunko node --input-type=module < scripts/docker-smoke.mjs
# Remove only this disposable project's containers, network and generated test data:
docker compose -f docker-compose.full.yml -p bunko-smoke down -v
```

Real private Kavita scans and Sonarr/Prowlarr grabs, source-dependent downloads and Cloudflare behavior remain unverified until the operator connects those services and chooses extensions. The API reports missing configuration; the tests do not pretend those services exist. The frontend handoff documents these limits.


## Interface checks (2026-10-15, Claude)

The interface was rebuilt from scratch. The shared contract in `src/types/shared.ts` was written first; API and interface were then implemented against it.

- `npm run check` passes: ESLint with zero warnings, strict TypeScript, 98 tests (API fixtures plus the i18n parity test), optimized production build.
- Chromium screenshots at 1440×900 and 390×844 for every page (home, catalog, search, title, library, new chapters, downloads, sources, settings), with no page wider than the viewport and no JavaScript errors. Real public AniList/MangaDex/MangaUpdates data was used; no runtime demo data.
- The title-page chapter flow (automatic matching across two sources, doubtful candidate, merged variants, range selection, bulk action bar) was checked on desktop and mobile with browser-only intercepted fixtures; no request reached a real source and nothing was downloaded.
- Docker: image rebuilt, isolated `bunko-qa` stack healthy with real pinned Suwayomi. Real browser login succeeded at `http://localhost:2512` and `http://127.0.0.1:2512`; a cross-site login POST returned 403 and a wrong token 401. English interface checked against the live container. The stack and its volumes were removed afterwards.

Not verified: a real Suwayomi with installed extensions, real chapter downloads/imports, a real Kavita instance (scan and reading progress), and Cloudflare-protected sources. These need the operator's own services and extension choices.
