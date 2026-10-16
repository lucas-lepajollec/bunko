# Bunko

Self-hosted reading hub over Suwayomi and Kavita: manga, manhwa/webtoons, manhua and light/web novels. Node 22, Next.js App Router, SQLite/FTS5, one container.

- Read `docs/architecture.md`, `docs/api.md` and `src/types/shared.ts` before changing integrations. The shared contract binds the API (`src/lib`, `src/app/api`) and the interface (`src/app`, `src/components`, `src/lib/client`); change both sides and the docs together.
- Every user-visible string uses `t()` with keys for en, fr, es, de and it in `src/i18n/messages.ts`; `tests/i18n.test.ts` enforces identical keys and placeholders. Fonts are bundled locally (no network at build).
- Visual direction "cinema × bookshop": full-bleed artwork, display titles, serif asides, numbered shelves, neutral chrome and a per-title accent from the cover colour. No sidebar dashboards.
- Keep 64-bit Suwayomi source IDs as strings. Never log upstream bodies, credentials, request authentication, settings secrets or token files. Settings responses are redacted.
- SQLite, the settings encryption key and the access token live in `data/`; never commit runtime data, media or credentials.
- The worker confirms `isDownloaded` on every chapter; an empty queue never proves success. Imports and scans must stay retryable across restarts.
- Validate with `npm run check`, and `scripts/container-smoke.sh` after packaging changes. Tests use isolated storage and local fixtures only.
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). Local private context belongs in the ignored `AGENTS.override.md` and `.project-local/`.
- Default ports: 2512 (production), 2498 (development).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
