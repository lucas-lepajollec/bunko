#!/usr/bin/env node
/**
 * Load benchmark against a running production build with an EMPTY data directory:
 *   BUNKO_DATA_DIR=/tmp/bunko-perf node node_modules/next/dist/bin/next start -p 2630 &
 *   node scripts/perf/load.mjs --url http://127.0.0.1:2630 --works 5000 --pid <server pid>
 * Creates an admin, adds N mixed works through the API, then measures endpoint latency and
 * size, and the server's idle CPU (Linux /proc). Compares with scripts/perf/budgets.json and
 * exits non-zero when a budget is exceeded. Prints aggregates only (no data, no secrets).
 */
import { readFileSync } from 'node:fs';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const base = args.url ?? 'http://127.0.0.1:2630';
const N = Number(args.works ?? 5000);
const pid = args.pid ? Number(args.pid) : null;
const idleSeconds = Number(args.idle ?? 300);
const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
const h = { 'content-type': 'application/json', origin: base };
const password = 'perf-password-12345';
await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ username: 'perfadmin', password }),
});
const login = await fetch(`${base}/api/auth`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ username: 'perfadmin', password }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('login failed');
const kinds = [
  ['MANGA', 'MANGA'],
  ['MANGA', 'MANHWA'],
  ['NOVEL', 'LIGHT_NOVEL'],
  ['NOVEL', 'NOVEL'],
  ['ANIME', null],
  ['ANIME', 'SERIES'],
  ['ANIME', 'MOVIE'],
];
const media = (i) => {
  const [type, format] = kinds[i % kinds.length];
  const id =
    format === 'SERIES'
      ? `tmdbtv:${100000 + i}`
      : format === 'MOVIE'
        ? `tmdbmovie:${100000 + i}`
        : `mangaupdates:${900000 + i}`;
  return {
    id,
    adult: false,
    title: `Perf Work ${i}`,
    type,
    altTitles: [],
    anilistId: null,
    mangadexId: null,
    mangaUpdatesId: id.startsWith('mangaupdates') ? String(900000 + i) : null,
    coverUrl: null,
    bannerUrl: null,
    synopsis: 'Synopsis '.repeat(20),
    genres: ['Action'],
    authors: ['Someone'],
    score: 70,
    status: 'RELEASING',
    chapters: 100,
    episodes: 12,
    webUrl: null,
    providers: [],
    sources: [],
    trackedId: null,
    kavitaSeriesId: null,
    kavita: null,
    format,
    origin: 'JP',
    year: 2000 + (i % 25),
    volumes: null,
    color: null,
    popularity: i,
    startDate: `${2000 + (i % 25)}-01-01`,
  };
};
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < N) {
      const i = next++;
      const r = await fetch(`${base}/api/tracked`, {
        method: 'POST',
        headers: { ...h, cookie },
        body: JSON.stringify({ media: media(i), status: 'READING' }),
      });
      if (!r.ok) throw new Error(`add ${i}: HTTP ${r.status}`);
    }
  }),
);
const results = {
  works: N,
  addMsPerWork: Math.round(((performance.now() - started) / N) * 10) / 10,
  endpoints: {},
};
for (const ep of Object.keys(budgets.endpoints)) {
  const times = [];
  let bytes = 0;
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    const r = await fetch(base + ep, { headers: { cookie } });
    bytes = (await r.arrayBuffer()).byteLength;
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  results.endpoints[ep] = {
    p50: Math.round(times[3]),
    max: Math.round(times[6]),
    kb: Math.round(bytes / 1024),
  };
}
if (pid) {
  const ticks = () =>
    readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(' ')
      .slice(13, 15)
      .reduce((a, b) => a + Number(b), 0);
  await new Promise((r) => setTimeout(r, 120_000)); // settle after the burst of additions
  const a = ticks();
  await new Promise((r) => setTimeout(r, idleSeconds * 1000));
  results.idleCpuPercent = Math.round(((ticks() - a) / idleSeconds) * 100) / 100;
}
console.log(JSON.stringify(results, null, 2));
const failures = [];
if (results.addMsPerWork > budgets.addMsPerWork)
  failures.push(`add ${results.addMsPerWork} ms/work`);
for (const [ep, b] of Object.entries(budgets.endpoints)) {
  const r = results.endpoints[ep];
  if (b.p50 && r.p50 > b.p50) failures.push(`${ep} p50 ${r.p50} ms > ${b.p50}`);
  if (b.kb && r.kb > b.kb) failures.push(`${ep} ${r.kb} KB > ${b.kb}`);
}
if (results.idleCpuPercent !== undefined && results.idleCpuPercent > budgets.idleCpuPercent)
  failures.push(`idle CPU ${results.idleCpuPercent}% > ${budgets.idleCpuPercent}%`);
if (failures.length) {
  console.error(`Budgets exceeded:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
