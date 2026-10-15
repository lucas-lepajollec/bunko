# KaviSeerr

A self-hosted manga, manhwa, light-novel and anime hub connecting Suwayomi, Kavita, Sonarr and Prowlarr. The multilingual interface (English, French, Spanish, German, Italian) covers discovery, catalog filters, two-level search (catalogs plus live per-source results), Mihon-style source browsing with extension filters, title sheets with automatic source matching and a chapter table, a library with reading statuses and read/owned/released progress, new-chapter feed, downloads, extension management and settings. Desktop and mobile layouts are both supported.

## Run with Docker

Requirements: Docker Engine and Docker Compose v2, about 2 GB available RAM for the complete stack, outbound HTTPS for metadata and installed extensions.

```sh
docker compose up -d --build --wait
curl --fail http://localhost:2512/api/health
```

The application listens on **2512:2512**. Open the interface at `http://localhost:2512`. Browser login works on `localhost` and IP addresses; cross-site requests are rejected. Suwayomi and FlareSolverr are internal services, with no published host ports. This new local project has no published application image: Compose deliberately builds the source. The pinned upstream images are Suwayomi `v2.4.2366` and FlareSolverr `v3.5.2`.

An access token is generated once in the persistent `app-data` volume. To view it **locally**, run:

```sh
docker compose exec kaviseerr cat /data/access.token
```

Do not paste that token into chats, screenshots or repository files. API clients use `Authorization: Bearer <token>`. Browser clients sign in with `POST /api/auth` and receive an HttpOnly session cookie; this also authenticates native `EventSource` streams. See [the API contract](docs/api.md).

## Connect your services

Sign in, open **Paramètres** and enter service base URLs and keys, or use `PATCH /api/settings`. All sensitive values are encrypted at rest. Settings reads return only secret-presence flags; omitted secret fields stay unchanged, an explicit empty string clears them.

- Suwayomi defaults to `http://suwayomi:4567` in Compose, headless, CBZ enabled. Set `extensionRepos` to repositories you trust; none is bundled. Refresh with `POST /api/extensions/action`, then install selected packages. `GET /api/sources` lists installed French sources; `favoriteSourceIds` limits live searches to your selection. `POST /api/catalog/sync` indexes popular pages on demand; deep searches also index their actual results. This is a progressively populated cache, not a promise of exhaustive source catalogs.
- Kavita, Sonarr and Prowlarr are existing external services. Use addresses reachable **from the application container**, not the host's `localhost`. When these services run in Docker, join the same external Docker network via an override and use their service names.
- Give Kavita the application's **library volume** as a library root, for example mount the Compose-created volume `<compose-project>_library` at `/library` in Kavita. It must be readable by Kavita's UID (application-created files use UID 1000). Set `kavitaLibraryPath` to that path **inside Kavita**. Add the root to a Kavita manga library before importing. Kavita requires a valid key with scan permissions. `kavitaAuthMode: "api-key"` uses `x-api-key`; older installations can select `"jwt"` for the Plugin/authenticate flow.
- Sonarr interactive search requires its existing numeric `seriesId`. Prowlarr text search uses `query`. The returned provider travels with the release selection so the grab goes back to the right service.

The worker imports only chapters confirmed downloaded by Suwayomi, embeds `ComicInfo.xml` in each CBZ, writes a series metadata file and allowed-provider HD cover, then requests Kavita's folder scan. Failed batches remain visible and retryable. The worker keeps running when browsers disconnect. Automatic chapter checks run every 15 minutes for tracked manga/novels with explicit source selections.

## Development and verification

Node.js 22.x:

```sh
npm ci
npm run dev
npm run check
```

Open **http://localhost:2498** after `npm run dev`. Read your generated local `data/access.token` to sign in; the token is never stored in browser storage. Development binds to `127.0.0.1:2498`; `npm run dev:lan` binds all host interfaces. In local Node development set `SUWAYOMI_URL` to an accessible Suwayomi base URL. Other settings remain in SQLite. Optional environment configuration: `KAVISEERR_DATA_DIR` (default `./data`), `KAVISEERR_LIBRARY_DIR` (default `./media`), `KAVISEERR_WORKER=false` (tests only). `npm start` binds production to localhost:2512; the Docker standalone server binds all container interfaces.

Tests use isolated storage, generated test secrets, local HTTP protocol fixtures and synthetic archive bytes. They never use personal accounts or real media. [Architecture and verification limits](docs/architecture.md).

## Operations

```sh
docker compose ps
docker compose logs --tail 100 kaviseerr
docker compose stop
# Back up all three named volumes while stopped.
docker compose start
```

`app-data` contains SQLite, WAL, `settings.key` and `access.token`: keep the whole volume together, encrypted in your backup system. `suwayomi-data` contains extension state and original downloads. `library` contains the imported CBZ library and metadata. Database files and secrets are private to UID 1000. Volumes are initialized by their images; bind-mount replacements must be writable by the image user. Do not omit the key files during restore.

To restore, stop the stack, restore **all three** volumes to the matching versions with UID ownership intact, then start and check health. Schema version 1 creates tables idempotently. No destructive migrations are performed. Keep a stopped-volume snapshot before changing application/schema versions.

Update deliberately from reviewed source, preserve the old local image with `docker image tag kaviseerr:local kaviseerr:previous`, then rebuild and recreate. On failure restore the matching volume snapshot and run the old image through a Compose override. Do not downgrade a database after a future migration without its matching backup.

`docker compose down` removes containers and network while retaining volumes. **`down -v` deletes all application and media data.** To rotate the application access token, stop KaviSeerr, remove only `access.token` through your local volume administration tool, then start it; existing browser sessions become invalid.

For localhost-only access change the port mapping to `127.0.0.1:2512:2512`. For access through a reverse proxy, keep the original Host header and disable buffering/timeouts for SSE. Use TLS for access outside your trusted LAN. No Docker socket or host privilege is needed.

## Interface and contracts

The catalogue queries public metadata on demand. **Deep Search FR** in a media sheet lists actual installed-source matches; select sources, load chapters, choose variants or a numeric range, then enqueue the selection. **Activer le suivi auto** enables automatic downloads for those explicit sources. Following a title alone leaves automatic downloads off. Anime sheets offer Sonarr/Prowlarr interactive search, language/codec/resolution filters and provider-correct grabs. Light novels use installed Suwayomi sources; EPUB scraping/conversion is not implemented.

Downloads display live queue state separately from persisted import batches. Unavailable services appear as errors. Settings remain editable while Suwayomi is unreachable, and clearing a saved secret requires its explicit checkbox. `Ctrl/Cmd+K` opens quick search; Escape closes dialogs. The layout adapts to mobile/tablet and respects reduced motion. No demo catalogue is inserted.

- [Shared TypeScript contract](src/types/shared.ts)
- [Exact endpoints and events](docs/api.md)

Project created locally; no remote, image publication or public release has been configured. The open-source goal is recorded, but a license still needs the owner's choice before publication.
