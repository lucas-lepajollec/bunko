# Security policy

Bunko is a self-hosted media hub that stores credentials for your self-hosted services (Suwayomi, Kavita, Jellyfin/Emby, Stash, Sonarr, Radarr, Prowlarr, qBittorrent, TraDoc, and optional public catalog keys), fetches metadata and feeds, relays streams, and writes downloaded/translated files into your library. Please report suspected vulnerabilities privately so they can be investigated and fixed before details become public.

## Supported versions

| Version | Support status |
| --- | --- |
| `main` and the latest published image | Supported |
| Older images | Best effort; upgrading may be required |
| Third-party forks or unofficial images | Not supported |

## Reporting a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/lucas-lepajollec/bunko/security/advisories/new).

If private reporting is not available, open a minimal issue asking for a private contact channel. Never include exploit code, access tokens, session keys, API keys, private URLs, configuration files, or the contents of the `data` volume in a public issue.

Please include, when possible: the affected commit or image tag, the deployment method, reproduction steps and impact, sanitized logs or a minimal proof of concept, and any known workaround.

You should receive an acknowledgement within seven days and an initial assessment within fourteen days.

## Trust boundaries

### Accounts, setup, and permissions

- **First-start setup code**: On a fresh volume with no administrator account, Bunko generates a one-time 12-character setup code (`XXXX-XXXX-XXXX`), stores its SHA-256 hash in `accounts.db`, writes the code to `/data/setup.code` (`0600`), and prints it once to startup logs. Completing initial setup requires this code (or an operator-configured `BUNKO_SETUP_CODE`) and deletes `/data/setup.code` immediately after the administrator account is created.
- **Account recovery**: Starting Bunko with `BUNKO_RESET_ACCOUNT=true` clears only the first administrator's password, rotates that account's session epoch, and generates a one-time `/data/recovery.code` (`0600`) whose hash is checked before a new password can be set. Other accounts, libraries, settings, and the Bearer token stay intact. Remove `BUNKO_RESET_ACCOUNT` once recovery completes.
- **Least-privilege member accounts**: Administrators manage users and shared catalog keys. New `member` accounts have five granular permissions (`services`, `extensions`, `downloads`, `translate`, `adult`). By default, new `member` accounts receive only `downloads` and `translate`; `services`, `extensions`, and `adult` are disabled until an administrator explicitly grants them. Existing persisted accounts keep their saved permissions across upgrades.
- **18+ (`adult`) enforcement**: Enabling `adultContent`, `adultMode`, disabling `hideNsfwSources`, overriding per-work or bulk 18+ flags, or creating an unlinked sheet marked 18+ (or filed in an 18+ extension section) all require the `adult` permission.
- **Passwords and rate limiting**: Passwords are stored as versioned salted `scrypt` hashes (`N=32768`, `r=8`, `p=1`, `maxmem=64 MiB`) and verified in constant time (including a dummy derivation for unknown usernames). Concurrent `scrypt` work is bounded (4 active, 16 queued) to prevent memory/CPU exhaustion. Authentication attempts are rate-limited per normalized username (10/minute) and per client IP (when `BUNKO_TRUST_PROXY=true`) or direct fallback (30/minute).

### Sessions, cookies, headers, and CSRF protection

- **Separated keys**: Session cookies are HMAC-SHA256 signed with a dedicated `/data/session.key` (`0600`), decoupled from `/data/access.token` (`0600`, used strictly for `Authorization: Bearer` automation). Rotating `access.token` does not affect browser sessions, and a leaked `access.token` cannot forge browser session cookies.
- **Cookies behind TLS reverse proxies**: Browser sessions use 7-day `HttpOnly; SameSite=Strict` cookies; password changes rotate the account's `session_epoch` and invalidate older sessions. Set `BUNKO_TRUST_PROXY=true` behind a TLS-terminating reverse proxy (honoring `X-Forwarded-Proto: https` and `X-Forwarded-For`), or `BUNKO_SECURE_COOKIES=true` to force the `Secure` attribute unconditionally on both cookie issuance and logout clearing.
- **CSRF and HTTP headers**: State-changing requests reject mismatched/`null` `Origin` headers (compared against `Host`, never `X-Forwarded-Host`; reverse proxies must preserve `Host`) as well as `Sec-Fetch-Site: cross-site` on non-Bearer requests. Global HTTP headers set `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (required for the same-origin EPUB reader frame), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and `Content-Security-Policy: frame-ancestors 'self'; object-src 'none'; base-uri 'self'`.

### Secrets and data volume

- Service credentials and optional catalog API keys are encrypted at rest (AES-256-GCM) with `/data/settings.key` (`0600`), separate from SQLite, and are never returned by the API or written to logs.
- Protect and back up the entire `/data` volume: it holds `accounts.db`, per-user databases (`users/<id>/bunko.db`), `settings.key`, `session.key`, and `access.token`.

### Integrations, SSRF, and media/archive boundaries

- **Video extensions and SSRF (`safe-fetch`)**: Requests to third-party video extensions, relays, and subtitles check the resolved IP at socket connection time (defeating DNS rebinding), block private/loopback/link-local/metadata IPv4 and IPv6 ranges, follow redirects manually with per-hop validation, and strip credentials across origins. Operators may opt into LAN/Docker video addons via `BUNKO_VIDEO_ALLOWED_HOSTS` (host, `host:port`, or CIDR).
- **RSS / Atom news feeds**: User-configured `newsFeeds` use `safe-fetch` with `allowConfiguredHosts: false`, so member-editable RSS feeds cannot probe private hosts allowlisted in `BUNKO_VIDEO_ALLOWED_HOSTS`.
- **Self-hosted media servers (Jellyfin/Emby, Stash, *arr, qBittorrent, TraDoc)**: Upstream credentials stay server-side. Stream proxies for Jellyfin, Stash, and video extensions allowlist media `Content-Type` headers, set `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cross-Origin-Resource-Policy: same-origin`, and cap HLS playlists at 8 MiB. TraDoc downloads are streamed with a hard 300 MiB byte ceiling before writing atomically into validated library paths.
- **Built-in CBZ and EPUB readers**: Paths are confined to each account's validated `mediaRoot`. EPUB documents strip scripts/event handlers and are served under a `script-src 'none'` CSP. Both CBZ and EPUB readers enforce archive entry-count limits and hard per-entry decompression caps (20 MiB via `zlib` `maxOutputLength`, 5 MiB for EPUB metadata XML, 512 MiB declared archive total) to prevent zip-bomb memory exhaustion.
- **External services and extensions**: Suwayomi and FlareSolverr in the bundled Compose stack publish no host ports and should not be exposed directly. Bunko ships with no third-party extension repositories; install only sources you trust.
