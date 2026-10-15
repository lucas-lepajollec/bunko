# Security policy

KaviSeerr is a self-hosted application that stores credentials for Suwayomi and Kavita, downloads files from third-party sources and writes them into your library. Please report suspected vulnerabilities privately so they can be investigated and fixed before details become public.

## Supported versions

| Version | Support status |
| --- | --- |
| `main` and the latest published image | Supported |
| Older images | Best effort; upgrading may be required |
| Third-party forks or unofficial images | Not supported |

## Reporting a vulnerability

Use the repository's [private vulnerability reporting form](https://github.com/lucas-lepajollec/kaviseer/security/advisories/new).

If private reporting is not available, open a minimal issue asking for a private contact channel. Never include exploit code, access tokens, API keys, private URLs, configuration files or the contents of the `data` volume in a public issue.

Please include, when possible: the affected commit or image tag, the deployment method, reproduction steps and impact, sanitized logs or a minimal proof of concept, and any known workaround.

You should receive an acknowledgement within seven days and an initial assessment within fourteen days.

## Trust boundaries

- The web interface and API require the access token generated on first start (`/data/access.token`). Browsers receive an HttpOnly session cookie; state-changing requests from another origin are rejected. Reverse proxies must preserve the original `Host` header.
- Service credentials are encrypted at rest with a separate generated key (`/data/settings.key`) and are never returned by the API. Back up and protect the whole `data` volume: it contains the database, the access token and the key.
- Suwayomi and FlareSolverr are internal services in the provided Compose file and publish no host ports. Do not expose them directly.
- Extensions are third-party code run by Suwayomi. KaviSeerr ships with no extension repository; add only repositories you trust.
- Downloaded archives are size-limited and validated before import; files are written only under the configured library folder.
