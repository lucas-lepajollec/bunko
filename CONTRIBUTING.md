# Contributing

Thanks for helping improve Bunko. Small, focused pull requests with clear evidence are the easiest to review.

## Development setup

Requirements: Node.js 22 and npm. A reachable Suwayomi server is needed for sources, chapters and downloads; the catalog works without it.

```bash
npm ci
SUWAYOMI_URL=http://localhost:4567 npm run dev   # http://127.0.0.1:2498
```

Sign in with the token generated in `data/access.token`. `data/` and `media/` are local runtime folders and are ignored by Git.

## Validation

Run before opening a pull request:

```bash
npm run check   # lint (0 warnings), strict TypeScript, tests, production build
docker build -t bunko:dev .
```

Tests use temporary storage and local protocol fixtures only. Never add real credentials, personal media or private infrastructure data to tests or fixtures.

## Guidelines

- `src/types/shared.ts` is the contract between the API (`src/lib`, `src/app/api`) and the interface (`src/app`, `src/components`). Change both sides and the docs together.
- Every user-visible string goes through `t()` with keys in `src/i18n/messages.ts` for all five languages; `tests/i18n.test.ts` checks keys and placeholders.
- Keep 64-bit Suwayomi source IDs as strings. Never log upstream bodies, credentials or tokens.
- Update `CHANGELOG.md` and the relevant documentation when users or operators are affected.
- Read [AGENTS.md](AGENTS.md) for repository conventions.

## Pull requests

Describe the problem, the change and how you validated it. Include screenshots for visible changes (desktop and mobile). Security issues go through [SECURITY.md](SECURITY.md), not pull requests.
