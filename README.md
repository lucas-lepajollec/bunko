<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo-light.svg" width="72" height="72" alt="Bunko">
</picture>

# Bunko

**Find a manga, webtoon or light novel, pick its chapters, read them in Kavita.**

A self-hosted reading hub that sits on top of the Suwayomi and Kavita you already run.

[![CI](https://github.com/lucas-lepajollec/bunko/actions/workflows/ci.yml/badge.svg)](https://github.com/lucas-lepajollec/bunko/actions/workflows/ci.yml)
[![Docker image](https://github.com/lucas-lepajollec/bunko/actions/workflows/docker.yml/badge.svg)](https://github.com/lucas-lepajollec/bunko/pkgs/container/bunko)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey.svg)](LICENSE)

[Quick start](#quick-start) · [Configuration](#configuration-and-persistence) · [Security](#security-privacy-and-limitations) · [Contributing](CONTRIBUTING.md)

</div>

## Overview

[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) runs Mihon/Tachiyomi-compatible extensions and downloads chapters. [Kavita](https://www.kavitareader.com/) is a great reader. Between the two, finding a title, checking which source has it and getting clean files into your library is still tedious. Bunko is that missing layer:

| | What it does |
| --- | --- |
| **Catalog first** | Instant search and browsing over AniList, MangaDex and MangaUpdates — covers, synopses, seasons and release dates, not raw source listings. |
| **Sources second** | Each title is matched automatically to your installed extensions, ranked by title similarity. A live search across every extension finds what no catalog lists. |
| **One click to Kavita** | Pick missing chapters, a range or a specific version per chapter. They arrive as CBZ files with embedded `ComicInfo.xml`, and Kavita rescans the series. |
| **Follow, don't babysit** | Reading statuses, read / owned / released progress (from Kavita), automatic fetching of new chapters and a daily release feed. |

Bunko does not host, provide or recommend any content source, and ships with no extension repository.

## Product preview

The interface pairs full-bleed artwork and bold titles with a bookshop structure: numbered shelves, a table of contents for chapters, and a quiet neutral chrome tinted by each title's colour. It works on desktop and mobile, in English, French, Spanish, German and Italian. Screenshots will be added with the first tagged release.

## Highlights

- **Home** — this season's new series, titles to pick up again, the weekly top 10, the latest releases (newest first) and one shelf per format.
- **Catalog** — manga, manhwa & webtoons, manhua and novels; filter by genre, status, season and year; sort by trend, popularity, score or release date.
- **Search** — results in a dropdown as you type, from any page; then the full catalog results or a live search inside your extensions, source by source.
- **Title sheet** — automatic source matching with priorities, merged chapter table (missing, unread, ranges, per-chapter version), bulk download, reading status, automatic fetching.
- **Library, new chapters, downloads** — shelves by reading status, a feed of detected chapters, and a visible pipeline: download → import → Kavita scan → ready, with retry.
- **Sources** — extension updates, health and latency per source, which sources join global search and in which order, repositories.

Light-novel downloads (EPUB into Kavita) are a planned module; novels can already be discovered and tracked.

## Quick start

You need a running **Suwayomi** server (v2.x) and, to read and track progress, a **Kavita** server. Bunko runs as a single container next to them.

**1. Create `docker-compose.yml`**

```yaml
services:
  bunko:
    image: ghcr.io/lucas-lepajollec/bunko:latest
    container_name: bunko
    restart: unless-stopped
    ports:
      - "2512:2512"
    volumes:
      - bunko-data:/data
      # Replace the left side with the folder that contains your Kavita libraries.
      - /path/to/your/kavita/libraries:/library

volumes:
  bunko-data:
```

That is the only path to adapt. A container can only write where you let it, so Bunko needs **one** mount: the folder your Kavita libraries live in (for example the parent of `manga/` and `webtoons/`). Everything else — Suwayomi and Kavita addresses, keys, and which library receives which format — is set in the interface. `bunko-data` keeps the database, your account, the API token and the encryption key.

The repository's [`docker-compose.yml`](docker-compose.yml) is the same service with hardening options (read-only filesystem, no capabilities) and an optional [`.env`](.env.example).

**2. Start it**

```sh
docker compose up -d
```

**3. Create your account and connect your services**

Open `http://<your-host>:2512`. On first start you choose a username and a password (the first visitor creates the administrator account, so do this right away). Then, in **Settings → Connections**:

| Setting | Example | Notes |
| --- | --- | --- |
| Suwayomi address | `http://192.168.1.10:4567` | As reachable **from the Bunko container**. Username and password if Suwayomi uses basic authentication. |
| Kavita address and API key | `http://192.168.1.10:5000` | Use the API key of a Kavita **administrator**: only admins may scan folders and set covers. |
| Kavita path of the mounted folder | *(empty)* | Optional. Bunko finds which of Kavita's folders sit under `/library` by itself; fill it only if detection fails. |

Then, in **Settings → Kavita libraries**, pick the library folder that receives each format (manga, manhwa & webtoons, manhua, novels). Your Suwayomi extensions are listed under **Sources**: choose which ones join global search, open a title and pick chapters.

Bunko also indexes what Kavita already holds: titles you own show an *In Kavita* badge, owned chapters are never downloaded again, and existing series can be followed from **Library → In Kavita**.

> **Good to know.** Bunko asks Suwayomi only for the chapter pages, then builds each CBZ itself, named the way Kavita expects (`Series/Series Ch. 0012.cbz`) with embedded metadata. Suwayomi's own download folder and settings are left untouched, and the two containers do not need to share a volume.

<details>
<summary><b>Several people?</b> One Bunko, one separate instance per account</summary>

The administrator creates accounts in **Settings → Users**. Each account is a separate Bunko: its own settings, Suwayomi and Kavita connections, library, downloads and content filter. To share a Suwayomi server, simply enter the same address in both accounts.

Mount each person's Kavita folder as a subfolder of `/library` (any names), then each account picks its folder in **Settings → Kavita libraries**. Two accounts cannot use the same folder.

```yaml
    volumes:
      - bunko-data:/data
      - /path/to/first/kavita/libraries:/library/disk1
      - /path/to/second/kavita/libraries:/library/disk2
```

With a single account you can keep mounting your folder directly at `/library`, as above.

</details>

<details>
<summary><b>Starting from scratch?</b> Run Bunko with its own Suwayomi and FlareSolverr</summary>

[`docker-compose.full.yml`](docker-compose.full.yml) adds a headless Suwayomi engine and FlareSolverr on an internal network (no extra published ports):

```sh
docker compose -f docker-compose.full.yml up -d
```

Then add an extension repository you trust under **Sources → Repositories** and install extensions. Bunko ships with none.

</details>

<details>
<summary><b>Troubleshooting</b></summary>

- **Suwayomi shows "unreachable".** Inside a container, `localhost` is the container itself. Use the host's LAN address, a shared Docker network and the Suwayomi service name, or `host.docker.internal` with `extra_hosts: ["host.docker.internal:host-gateway"]`.
- **Imports fail, or a library folder is greyed out in Settings.** The container runs as UID 1000: the mounted folder must be writable by that user (`chown 1000:1000` or matching ACLs). Folders outside the mounted one cannot be selected.
- **Kavita does not show new chapters.** Check that "Kavita path of the mounted folder" matches Kavita's own mount of the same host folder, and that the target folder belongs to a Kavita library.
- **A source fails or is slow.** The source list shows the reason reported by the extension (Cloudflare, HTTP error, login required). Update the extension under **Sources**; Cloudflare-protected sites may need FlareSolverr configured in Suwayomi.

</details>

## Configuration and persistence

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUWAYOMI_URL` | `http://suwayomi:4567` | Optional initial Suwayomi address; the address saved in Settings takes precedence. |
| `BUNKO_DATA_DIR` | `/data` in the image | Database, `access.token`, `settings.key`. |
| `BUNKO_LIBRARY_DIR` | `/library` in the image | Folder receiving imported CBZ files. |

Everything else lives in **Settings**: connections, new-chapter check interval (5 minutes to 24 hours), interface language. Source order, languages and repositories live in **Sources**.

- **Back up the `/data` volume as a whole** while the container is stopped: the database, the access token and the encryption key belong together.
- **Forgot your password?** Start the container once with `BUNKO_RESET_ACCOUNT=true`, create the account again, then remove the variable (otherwise the account is reset at every start). Settings and library are kept.
- **API and scripts** authenticate with `Authorization: Bearer <token>`, the token being in `/data/access.token`. To rotate it, stop the container, delete that file and start again.
- **To update**, `docker compose pull && docker compose up -d`. Images are published for `amd64` and `arm64`; pin a version tag (`ghcr.io/lucas-lepajollec/bunko:x.y.z`) once releases are tagged.

## Security, privacy, and limitations

- The interface requires the account created on first start (scrypt-hashed password, HttpOnly session; changing the password signs other sessions out). API clients use a separate bearer token. State-changing requests from other origins are rejected. Behind a reverse proxy, keep the original `Host` header, disable buffering for server-sent events and use TLS outside your LAN.
- Service credentials are encrypted at rest and never returned by the API. The container runs read-only, as a non-root user, without capabilities.
- Catalog metadata comes from the public AniList, MangaDex and MangaUpdates APIs; titles and synopses stay in their source language.
- Sources depend on third-party extensions and websites. Matching is title-based and labels doubtful candidates instead of guessing.
- Novel downloads and the video module (Sonarr/Prowlarr) are not in the interface yet.

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Architecture

Next.js 16 (App Router) on Node 22, in one container. The API talks to Suwayomi over GraphQL, to Kavita over REST and to the metadata providers; SQLite (WAL, full-text search) stores the library, settings, source health and the release feed. A durable worker runs imports, Kavita scans, progress refresh and scheduled checks, and resumes after restarts. The interface is built on the shared contract in [`src/types/shared.ts`](src/types/shared.ts).

[API reference](docs/api.md) · [Architecture notes](docs/architecture.md) · [Verification record](docs/verification.md)

## Development and quality

```sh
npm ci
SUWAYOMI_URL=http://192.168.1.10:4567 npm run dev   # http://127.0.0.1:2498, token in data/access.token
npm run check                                       # lint, strict TypeScript, tests, production build
scripts/container-smoke.sh "$(docker build -q .)"   # container health and authentication checks
```

Tests use temporary storage and local protocol fixtures — never real credentials or media. CI runs the same checks on every push and pull request, and multi-architecture images are published from `main`.

## Public demo

There is no public demo: Bunko is only useful with your own Suwayomi and Kavita.

## Documentation and community

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)

Released under the [MIT License](LICENSE).
