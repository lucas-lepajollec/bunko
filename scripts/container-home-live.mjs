import fs from 'node:fs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
const base = 'http://127.0.0.1:2512';
for (let i = 0; i < 60; i++) {
  if (
    await fetch(base + '/api/health')
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await delay(500);
}
const headers = { Authorization: `Bearer ${fs.readFileSync('/data/access.token', 'utf8').trim()}` };
const db = new Database('/data/bunko.db');
// Keep this check focused on real AniList; the provider ingestion has its own opt-in check.
db.prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)').run(
  'release_refresh',
  String(Date.now()),
);
async function api(path) {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, path);
  return response.json();
}
const start = Date.now();
await api('/api/home');
let home;
for (let i = 0; i < 40; i++) {
  await delay(500);
  home = await api('/api/home');
  if (home.top.length) break;
}
assert.equal(home.top.length, 10, 'Real AniList fills top ten');
const topMs = Date.now() - start;
const discovery = await api('/api/discover');
assert.ok(discovery.items.length > 0, 'Real unfiltered discovery is populated');
const candidate = home.top.find((m) => m.bannerUrl);
assert.ok(candidate, 'Real trending catalog contains banner artwork');
// A provider-only work starts without any AniList ID or banner; resolve its exact public title.
const media = {
  ...candidate,
  id: 'mangaupdates:900000000000',
  anilistId: null,
  mangadexId: null,
  mangaUpdatesId: '900000000000',
  bannerUrl: null,
  providers: ['mangaupdates'],
  trackedId: null,
};
const now = new Date().toISOString();
const release = {
  id: 'mangaupdates:900000000000',
  media,
  chapter: 1,
  volume: null,
  label: 'c.1',
  group: null,
  releasedAt: now,
  hasTime: true,
  provider: 'mangaupdates',
  trackedId: null,
};
db.prepare('INSERT INTO chapter_releases VALUES(?,?,?)').run(
  release.id,
  now,
  JSON.stringify(release),
);
// Only the persisted top/discover know the catalog work. The hero must enrich it independently.
const bannerStart = Date.now();
for (let i = 0; i < 30; i++) {
  home = await api('/api/home');
  if (home.hero.some((r) => r.media.bannerUrl)) break;
  await delay(500);
}
assert.ok(
  home.hero.some((r) => r.media.bannerUrl),
  'Provider-only hero resolves an AniList banner',
);
const persisted = db
  .prepare("SELECT payload FROM metadata_cache WHERE key LIKE 'hero:artwork:%'")
  .all()
  .map((r) => JSON.parse(r.payload));
assert.ok(
  persisted.some((m) => m?.bannerUrl),
  'Resolved banner persists',
);
for (let i = 0; i < 4; i++)
  assert.equal((await api('/api/home')).top.length, 10, 'Warm top stays populated');
console.log(
  JSON.stringify(
    {
      top: home.top.length,
      topMs,
      discover: discovery.items.length,
      hero: home.hero.length,
      bannerResolved: true,
      bannerMs: Date.now() - bannerStart,
      artworkCached: persisted.length,
    },
    null,
    2,
  ),
);
db.close();
