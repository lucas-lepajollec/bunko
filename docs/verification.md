# Verification — current and historical evidence

## Personal library and stable artwork — 2026-10-20

- Automatic artwork still comes from the linked catalog, then source thumbnails, then Kavita.
  Its successful bytes/hash and source URL survive source enrichment, reordering, upstream changes
  and reloads. The additive v16 migration preserves files/manual choices and defaults likes false.
  Work/explicit cover changes still select again; Kavita sync reuses the chosen bytes and checks
  that its target link is still current after asynchronous work.
- New isolated fixtures exercise migration/idempotence, authenticated likes without network or
  download side effects, tenant isolation, actual recent-reading order, safe bulk matching with
  concurrent/manual/collision/lease guards, local reading identity preservation, source-cover
  provenance and reader commit-before-response (including a previously debounced identical write).
  Final `npm run check` passes634 tests/53 files, including the asynchronous Kavita-link
  regression, with zero-warning lint, strict TypeScript and the production build.
- Zero-warning ESLint, strict TypeScript and optimized production builds pass. The final local
  Docker image builds; all114 isolated container checks pass, including the new matching route's
  authentication/input validation. No real service, queue, catalog key or media was changed.
- Production Chromium QA used a disposable account, generated artwork and synthetic chapter files
  at1440×1000,1280×800 (busy header),1024×768,768×400 and390×844. Checked real touch second-tap close,
  reopen/Escape/keyboard selection, mobile profile/likes menu links, scrollable format filters,
  individual-release cursor pagination, all-known-missing counts, likes/unlike persistence, empty
  likes and retained library data under a simulated503. No horizontal overflow or uncaught page
  error occurred; expected503 resource failures were injected deliberately.
- A real local CBZ and real progress handler verify reader→profile immediate reading-history
  refresh. A controlled source addition and delayed image replacement retain the chapter table,
  checkboxes and current artwork throughout the wait. Hover lift stays inside the row's padding;
  edge fades follow horizontal scroll and disappear at the end. Offscreen images remain lazy.
- Screenshots below contain fictional titles and deterministic geometric test covers only.
  They show the existing cinema/bookshop style, not replacement product artwork:
  [mobile profile](assets/personal-profile-mobile.png),
  [mobile library](assets/personal-library-mobile.png),
  [home hover and edge fade](assets/personal-home-hover.png).
- Scope remains local source/UI validation. NAS acceptance, real upstream availability and
  release/publication of this bundle are not claimed. Missing-stock counts cover observed source
  inventory; unobserved provider releases cannot be claimed exhaustive. SWR-memory/ZIP work from
  the earlier audit remains separate.

## Native image publication — 2026-10-20

- The successful preceding release run39482910545/attempt2 took19m13s: source validation3m56,
  amd64 build/smoke52s, emulated arm64 build/smoke7m16, then another6m07 building/pushing
  the multi-platform image. This is an observed single-run baseline, not an SLA.
- Release source validation and native amd64/arm64 build/smoke now run in parallel. Each native
  image is uploaded by digest, pulled back, checked for architecture and exact OCI revision,
  and smoke-tested before its digest becomes a job output. Tags wait for all three gates.
  The final job only assembles those immutable objects; its dry-run must retain all native
  image and attestation descriptors. No QEMU or publication rebuild remains in this workflow.
- `actionlint`1.7.11 and shell syntax validation pass. Nine isolated CLI-boundary regressions
  exercise valid promotion and refusal before tag writes for malformed inputs/metadata,
  a wrong architecture, missing attestations and a lossy merge. `npm run check` passes
  **623 tests/52 files**, lint, strict TypeScript and the production build. No runtime/dependency,
  database or interface change. Local Docker `bunko:native-publication` builds and all111 isolated
  smoke checks pass. Final descriptor-equality strengthening also passes the nine promotion
  cases. The first accepted native publication establishes actual timing.

- First accepted native run39488949397 completes in **3m56s**, versus19m13s on the preceding
  successful run (-79.5%,15m17s saved). ARM and amd64 jobs take2m09/2m45 alongside3m32 source
  validation. The published multi-platform image passes111 smoke checks after an anonymous
  pull; both native manifests retain their bound SPDX SBOM and SLSA provenance.
- The separate main CI exposes the preceding20k reader fixture's intermittent5s setup
  timeout again. Its fixed tenant namespace and insertion timestamp are now resolved once
  before the20k insert loop. A targeted workstation run falls from2064ms to581ms, with the
  same20k rows,12 measured requests, p95<250ms, zero upstream calls/writes and global5s limit.
  Full `npm run check` again passes623 tests/52 files, lint, TypeScript and production build;
  the final local Docker image passes111 smoke checks. This changes benchmark preparation
  only; native publication validation already passed.

## HTTP/1 catalog recovery — 2026-10-20

- A disposable standalone production browser with100 same-origin cover requests delayed12s
  reproduced six occupied connections. Its Manga request reached the server36.079s after
  catalog entry, while an independent health request took5ms. This establishes a connection
  starvation mechanism; it is not a network trace or a latency benchmark of Lucas's NAS.
- The corrected browser limits artwork to two cancellable transfers, including during fast
  scrolling. On the same slow-cover fixture, final Manga navigation took183ms including
  automation; earlier library/planning/known-sheet commands took104/78/254ms. All12 local
  fixture covers loaded, and390px mobile/1280px desktop had no horizontal document overflow.
  The real protected Metron image route also displayed decoded images with synthetic metadata
  and CDN responses, without browser cross-origin fetching or forwarded provider credentials.
- A separate pending→502→recovery scenario showed an error/partial notice with zero spinners
  or skeletons after failure, then usable results on focus. Unit regressions cover30s aggregate
  retry, the provider's additional60s503 cooldown, absent failed-provider payloads, cancellation,
  shared waits, bounded image payloads and API header/body deadlines.
- Local `npm run check` passes612 tests/50 files, lint, strict TypeScript and production build.
  Two subsequent catalog-state cases pass alongside the nine cache-schema cases; final lint,
  types and build are rerun for the frontend changes. Docker build and111 isolated container
  smoke checks pass; production dependency audit reports0 vulnerabilities. CI runs the combined
  suite on the final candidate. No dependency, migration, layout or real NAS data change.
- These checks establish the synthetic regressions above, not complete NAS acceptance or
  completion of the separate SWR-memory/ZIP profiling backlog.


## Reader optimization and publication candidate — 2026-10-19

- Final `npm run check` exits 0 (`.project-local/reader-optimized-check.{log,exit}`): zero-warning lint, strict TypeScript, **586 tests / 46 files**, optimized build. Two added regressions guard read-only repeated local identities and authenticated warm source refreshes at the retained 20,000-chapter limit.
- Twelve local authenticated chapter responses with full source-metadata fixtures measure **24.69 ms median / 34.21 ms p95**. Refreshes make zero upstream calls and zero tenant SQLite writes. This is a workstation fixture measurement, not a NAS latency promise. Local CBZ validation remains in place; no stale filesystem cache was introduced.
- Progress effects depend on the actual position/identity, not the changing neighbour/resume response. Local identities SELECT before creating a missing row, avoiding ignored AUTOINCREMENT writes. The next source chapter is resolved only in the last three pages. Hidden/offline polling remains paused and transient retries bounded.
- Final standalone browser QA with a disposable 12-page chapter confirms three current-chapter GETs (entry plus two polls), exactly one progress PUT, and zero next-chapter metadata GETs while staying on page 1 even after a new import. Reaching page 10 triggers exactly one next-chapter metadata GET; page 12 exposes Next, and chapter 2 starts on page 1. No console warnings/errors. Ignored `.project-local/reader-optimized-browser-counts.json` and `reader-optimized-proof.png` retain local evidence; temporary server/tab/storage are removed.

## Reader navigation refresh — 2026-10-19

- `npm run check` exits 0: zero-warning lint, strict TypeScript, **584 tests / 46 files**, optimized production build. Three new regressions cover newly imported neighbours through a warm/older combined cache without upstream page refetches, source-inventory updates excluding another manga, and offline local neighbour updates preserving page URLs/resume.
- Final transient-network retry configuration also passes lint, strict TypeScript and a fresh production build (`.project-local/reader-refresh-final-frontend.{log,exit}`, exit 0). The standalone final build recovers after deliberately stopping/restarting the disposable server: chapter 5 remains on page 3, the newly added chapter 6 becomes Next without navigation/reload, and opening it starts on page 1. Network/server failures retry at most three times with backoff; ordinary 4xx failures wait for focus/entry revalidation.
- Optimized production-server browser QA uses only a disposable account and synthetic three-page CBZs. Starting with one imported chapter, adding chapters 2/3 makes Next appear while chapter 1 remains on page 3; soft navigation opens chapter 2 on page 1. Repeated for local chapter 3→4 and Webtoon 4→5, retaining the current page/scroll until the user navigates. Revisits restore each chapter's own saved position. A deliberately unavailable local archive makes background metadata refresh fail while the already displayed page remains readable; the fixture archive is then restored. No console warnings/errors before this intentional failure.
- No layout, schema, dependency or packaging change. No new published image, real NAS/provider acceptance or deployment is implied. Test server/tab and temporary fixture storage are removed after QA.

## Incremental provider results without display gates — 2026-10-18

- Final frozen `npm run check` explicitly exits0: strict zero-warning lint, TypeScript, **581 tests/46 files**, optimized production build. Final Docker `bunko:progressive-results` builds (configcc573886…, wrappere375ea4…); **111 container smoke checks pass**. No dependency/schema change.
- Eleven new isolated regressions cover immediate local search, the first remote before other catalogs, owned/source-by-source chapters, no duplicate provider work, HTTP snapshot cancellation, fresh worker cache replacement, changed source namespaces, known-card sheet previews and tenant isolation, failure cooldown/recovery, independent novel catalogs, nonfatal warning compatibility, and revoked tenants. Targeted39/39 covers legacy OpenLibrary/comic discovery contracts. An initial full run caught six regressions in those contracts; they were corrected by retaining single-provider/unconfigured semantics and nonfatal text-catalog warnings, then the complete final suite passed.
- Production-image QA uses tmpfs-only state, a synthetic account,13 synthetic CBZs and deliberately staggered providers. The sheet shows13 owned rows before source responses, then40 source/owned rows while the slower source continues. Read/select/download controls remain available. Selecting chapter40 retains one selected item and an enabled download action when the remaining source expands the list to60. Browser checks were repeated on the final image after the bounded catalog compatibility adjustment.
- Catalog search displays one available result while other catalogs are still running, then adds the second without navigation. A failed remaining catalog retains both with an explicit incomplete-results warning. An already displayed card opens its sheet immediately with known title/status and a loading notice while full metadata is blocked (separate authenticated HTTP check:0.01s withpending=true for a synthetic5s detail load). Direct cold URLs without known metadata still need their initial provider response.
- Desktop,390×844 mobile and1280×600 low-height checks show no horizontal overflow or console warnings/errors. Screenshots contain synthetic content without artwork: [usable chapter rows desktop](assets/progressive-chapters-desktop.png), [mobile](assets/progressive-chapters-mobile.png), [first catalog result](assets/progressive-search-first-mobile.png), [additional results with partial warning](assets/progressive-search-more-mobile.png), [known-card sheet preview](assets/progressive-title-preview-mobile.png). Tabs/containers removed and viewport restored. No real NAS data/credentials or deployment/image publication.

## Durable source matches and original tome rows — 2026-10-18

- Nine new isolated regressions cover foreground persistence/refresh requests, manual edits during a scan, identical manual saves, custom queries, dismissals, tenant/server isolation, catalog enrichment, transient/config retries, final activity invalidation, and uniform tome rows/correction visibility. The existing activity response fixture now asserts its revision and releases blocked matching in `finally`.
- Frozen source validation: zero-warning strict ESLint and TypeScript pass; full suite **570 tests / 45 files** passes. The combined check log contains all successful stages, but its tool session returned143 after build; a separate production build explicitly exits0. Local Docker `bunko:source-sync-tomes` builds and **111 smoke checks pass**. Public CI remains the exact-commit integration gate.
- Production-image browser QA uses tmpfs-only state, synthetic account/providers and 13 synthetic CBZs. Start with a recent failed match and the library's “Sans source” badge; opening the sheet persists two staggered FR/EN matches, retains both after navigation, removes the badge and queues a durable release refresh, without manual source selection. Chapters appear from both sources.
- The existing chapter/tome switch remains. Only tome view exposes a small correction/undo button beside it. Correcting the13 misclassified archives produces13 normal chapter-style tome rows and reader actions. Tome2 completion persists as2 tomes after immediate exit; the library reports0 chapters and13 tomes. Undo restores detection; conservative automatic full-volume detection and future chapter imports remain covered by prior fixtures.
- Desktop1280×800, mobile390×844 and low-height1280×600 render without horizontal overflow or console warnings/errors; keyboard focus and correction/undo are checked. Rejected extra counting controls, dropdown and stock pills are removed. Screenshots use synthetic content without artwork: [normal rows desktop](assets/owned-volumes-rows-desktop.png), [mobile](assets/owned-volumes-rows-mobile.png), [correction desktop](assets/owned-volumes-correction-desktop.png), [mobile](assets/owned-volumes-correction-mobile.png). No NAS access, real credentials, image publication or deployment.

## Progressive results and owned tomes — 2026-10-18 (previous validation)

- Isolated regression fixtures cover schema v15 migration/idempotence, 13 existing files retyped as 13 volumes independently of presentation, reversal preserving chapter progress, future imports with overlapping numbers, tenant/connection isolation, safe local archive resolution, distinct reader identities and tome completions, known-volume coverage/read state, cache pending/failure transitions, followed sheet relations and release/home/planning flags. Older current-schema assertions now expect v15; standalone v14 migration assertions remain v14.
- `npm run check`: **561 tests / 43 files**, strict TypeScript and production build. Final acceptance and image smoke evidence is recorded with the branch checkpoint; no real runtime/credentials used.
- Production-image browser QA uses tmpfs-only state, a synthetic account, 13 synthetic CBZs and delayed metadata providers. Desktop and 390×844: declare current stock as tomes (the added counting controls were superseded by the correction above), see 13 owned/released tomes against 110 catalog chapters, finish tome2 and retain **2 tomes read** after leaving immediately. Known source-volume mappings then correctly reduce 40 unread chapters to24. Catalog search shows one fast result and an explicit incomplete notice, then automatically adds the second result and removes the notice. A failed provider retains both available results with an incomplete-results warning. No horizontal overflow or browser console errors observed.
- Screenshots contain **synthetic test data**, without cover artwork: [owned tomes desktop](assets/owned-volumes-rows-desktop.png), [mobile](assets/owned-volumes-rows-mobile.png), [search loading](assets/search-loading-mobile.jpg) and [partial provider failure](assets/search-partial-mobile.jpg). These prove interface behavior, not live catalog/NAS acceptance. This work does not publish or deploy an image.

## Source language preference — 2026-10-18

- Full `npm run check` passes: **551 tests / 42 files**, TypeScript and optimized build. Final `eslint . --max-warnings 0` and strict TypeScript pass after removing two unused fixture arguments; nine focused language/ranking cases pass again on that final test source.
- Regressions cover all five interface languages, matching relevance before language, language before chapter completeness, result availability before language, stable source ties, preserved saved filters/favourites, excluded languages, unsupported hints, browser-English/manual-French fetch and SSE, storage-blocked choices and retained 64-bit source IDs.
- Local `bunko:source-language` image builds; **111 container smoke checks** pass. Production browser QA uses disposable tmpfs-only data/library and synthetic Suwayomi responses: manually select German despite a French browser, verify DE source first, then select French and verify FR first with EN/DE retained. Desktop and 390×844 have no overflow/console errors. Temporary QA tab/container removed, viewport restored. No actual NAS or provider credentials used.
- Existing manual links and background language preferences remain preserved; this is foreground search/source-suggestion priority among eligible languages, not automatic extension installation or filter expansion. This validation does not publish an image or establish NAS acceptance.

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
