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

## Container publication

The release workflow validates the source and builds Linux amd64/arm64 candidates in
parallel on native GitHub runners (`ubuntu-24.04` and `ubuntu-24.04-arm`). Each architecture
is built once, uploaded by immutable digest with provenance/SBOM, pulled back and smoke-tested
on its native runner, including SQLite. Candidates have no release tags at this stage.

Only after source validation and both image tests succeed does `scripts/publish-image.sh`
assemble the verified digests into the multi-platform index. It checks both architectures and
retains their attestation descriptors before moving `latest`, full-SHA and applicable SemVer
tags. Publication does not rebuild the application. A failed gate leaves existing tags intact;
untagged candidates from a failed run may remain in GHCR.

BuildKit caches are separated by architecture (`bunko-amd64`/`bunko-arm64`). The required
`Docker image` PR/main check shares the amd64 cache scope, loads its own image and runs the
same isolated smoke tests without registry write permissions. GitHub's ref restrictions keep
pull-request cache writes separate from the trusted default branch. Required check names and
the application/dependency gates are unchanged. Cache transfers have a two-minute deadline;
an unavailable cache export does not fail an otherwise valid build. Validate workflow edits with `actionlint` and
the image-publication regression tests; the first accepted native run establishes actual timing.

References: [native GitHub runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Docker cache scopes](https://docs.docker.com/build/cache/backends/gha/),
[digest export](https://docs.docker.com/build/exporters/image-registry/) and
[manifest assembly](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).

## Guidelines

- `src/types/shared.ts` is the contract between the API (`src/lib`, `src/app/api`) and the interface (`src/app`, `src/components`). Change both sides and the docs together.
- Every user-visible string goes through `t()` with keys in `src/i18n/messages.ts` for all five languages; `tests/i18n.test.ts` checks keys and placeholders.
- Keep 64-bit Suwayomi source IDs as strings. Never log upstream bodies, credentials or tokens.
- Update `CHANGELOG.md` and the relevant documentation when users or operators are affected.
- Read [AGENTS.md](AGENTS.md) for repository conventions.

## Pull requests

Describe the problem, the change and how you validated it. Include screenshots for visible changes (desktop and mobile). Security issues go through [SECURITY.md](SECURITY.md), not pull requests.
