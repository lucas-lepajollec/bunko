# Security policy

Bunko is a self-hosted application that stores credentials for Suwayomi and Kavita, downloads files from third-party sources and writes them into your library. Please report suspected vulnerabilities privately so they can be investigated and fixed before details become public.

## Supported versions

| Version | Support status |
| --- | --- |
| `main` and the latest published image | Supported |
| Older images | Best effort; upgrading may be required |
| Third-party forks or unofficial images | Not supported |

## Reporting a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/lucas-lepajollec/bunko/security/advisories/new).

If private reporting is not available, open a minimal issue asking for a private contact channel. Never include exploit code, access tokens, API keys, private URLs, configuration files or the contents of the `data` volume in a public issue.

Please include, when possible: the affected commit or image tag, the deployment method, reproduction steps and impact, sanitized logs or a minimal proof of concept, and any known workaround.

You should receive an acknowledgement within seven days and an initial assessment within fourteen days.

## Trust boundaries

- The web interface uses a single administrator account created on first visit. Restrict access during setup: the first successful setup request becomes the administrator. Passwords are stored as versioned salted scrypt hashes (N=32768, r=8, p=1, maxmem=64 MiB) and verified with constant-time digest comparison, including a dummy derivation for unknown usernames. Authentication attempts are limited globally and per case-insensitive username. Browsers receive a seven-day HttpOnly SameSite=Strict session cookie signed with the existing access-token secret; password changes rotate the account session epoch and invalidate older sessions. API automation still uses `Authorization: Bearer <contents of /data/access.token>`; the token cannot sign browsers in. Public `GET /api/auth` exposes only setup/authentication state and the signed-in username. State-changing requests from another origin are rejected. Reverse proxies must preserve the original `Host` header.
- For forgotten account credentials, start/recreate the container with `BUNKO_RESET_ACCOUNT=true`; startup deletes the administrator and invalidates browser sessions while preserving settings, library data and the API token. It logs a reset notice without secrets. Complete setup again, then remove the flag so subsequent restarts preserve the new account. Protect the volume and deployment environment; operators with that access can reset authentication.
- Service credentials are encrypted at rest with a separate generated key (`/data/settings.key`) and are never returned by the API. Back up and protect the whole `data` volume: it contains the database, the access token and the key.
- Suwayomi and FlareSolverr are internal services in the provided Compose file and publish no host ports. Do not expose them directly.
- Extensions are third-party code run by Suwayomi. Bunko ships with no extension repository; add only repositories you trust.
- Downloaded archives are size-limited and validated before import; files are written only under the configured library folder.
