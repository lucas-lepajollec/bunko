# Performance and scale

Bunko is meant to stay quiet on a small home server with very large libraries (tens of thousands
of works, several accounts). This page lists the rules the code follows, the budgets, and how to
measure them.

## Rules

- **One description of kinds.** `src/domain/kinds.ts` describes every kind of work (family,
  formats, search type, catalog and release sources, unit, reading sources, dated releases).
  Lists, menus, validation, classification (`kindOfMedia`), worker lanes and pages derive from
  it. `tests/kinds.test.ts` fails when a kind lacks texts in a language, when a format belongs
  to zero or two kinds, or when a kind is not accepted everywhere a kind is chosen.
- **No work proportional to the library for one work.** Reading or adding one work uses indexed
  point queries (`getTracked`, `insertTracked`, `kavitaMatcher(id)`), never a scan of every work.
- **Caches are keyed by the version domain they depend on.** The 18+/identity graph uses the
  `identities` domain, which only changes with aliases, 18+ decisions and work identity fields.
  It is not rebuilt at all when there is no manual 18+ decision. A version read inside a
  transaction includes that transaction's writes, so a matching cache is safe there; a state
  computed inside a transaction is never stored.
- **Indexes or decode once.** Jellyfin and Kavita indexes are decoded once per sync and kept with
  lookup maps. Identity queries use `json_extract(media_json,'$.id')`, which the
  `tracked_identity` index serves (`->>` does not).
- **Unchanged data is not rewritten.** A write that changes nothing must not increment version
  domains: every increment invalidates projections and makes open browsers refetch.
- **Background work does only what is due.** A cover that cannot be fetched (no catalog image,
  no source, no Kavita series) waits longer each time (5 minutes doubling up to a day), and any
  change makes it due again. Source matching only runs when Suwayomi is configured.

## Budgets

`scripts/perf/budgets.json` holds the current budgets (5,000 mixed works, production build).
The main ones:

| Measure                         | Budget              |
| ------------------------------- | ------------------- |
| Idle CPU once settled           | ≤ 0.5 % of one core |
| Adding a work (through the API) | ≤ 25 ms             |
| `/api/library/activity` p50     | ≤ 50 ms, ≤ 8 KB     |
| `/api/home` p50                 | ≤ 250 ms            |
| `/api/planning` p50             | ≤ 300 ms            |

`tests/scale.test.ts` guards complexity in CI. Adding works costs the same at 200 and at 2,800
works. A per-work background sweep over 3,000 works never rebuilds identities. Only an identity
change does.

## Measuring

Against a production build with an empty data directory:

```sh
BUNKO_DATA_DIR=/tmp/bunko-perf BUNKO_LIBRARY_DIR=/tmp/bunko-perf-lib \
  node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 2630 &
npm run perf:load -- --url http://127.0.0.1:2630 --works 5000 --pid <server pid> --idle 600
```

The script creates an administrator, adds the works through the API, measures endpoints and,
with `--pid`, idle CPU from `/proc`. It exits non-zero when a budget is exceeded. A fresh library
does a first cover check on every work. Let it settle a few minutes before reading idle CPU.

To find where CPU goes, start the server with `node --inspect` and sample it with the Chrome
DevTools protocol (`Profiler.start`/`stop`), mapping frames through the `.next` source maps.

## Telemetry

Each worker lane (covers, source matching, update check, Kavita index, translations, Jellyfin,
anime works), release ingestion and every request is measured. `GET /api/admin/jobs`
(administrators) returns the jobs running now, totals per job and the last runs. The logs show a
line for any job above 2 s of CPU and for every 10-second window where the process uses at least
50 % of a core, naming what was running:

```sh
docker logs bunko 2>&1 | grep '\[bunko\]'
```

When the process stays at 80 % CPU or more, Bunko also profiles itself for 15 s (at most every
30 minutes; `BUNKO_PROFILE=off` disables it) and logs the hottest compiled positions. Map them
to source files with the same commit built locally:

```sh
npm run build
docker logs bunko 2>&1 | grep '\[bunko\] profile' | node scripts/perf/map-profile.mjs
```

## Results (VM, 5,000 works)

| Measure                            | Before                           | After                 |
| ---------------------------------- | -------------------------------- | --------------------- |
| Idle CPU, settled                  | 59–117 % of a core               | 0.3 %                 |
| Version increments per idle minute | 1,309                            | 0                     |
| Adding a work                      | 160 ms, growing with the library | about 20 ms, constant |
| `/api/planning` max                | 2.5 s                            | under 1 s             |
| Release ingestion (full run)       | 25.5 s CPU, > 100 % for minutes  | 1.9 s CPU             |

Next steps (tracked in the scalability plan): paginated library endpoints and virtualised
grids (`/api/tracked` still returns the whole library), a durable job table for background
work, narrower client invalidation, and a balanced mixed catalog and home.
