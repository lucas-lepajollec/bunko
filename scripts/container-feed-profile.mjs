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
// Each disposable run creates the first private instance before using its Bearer token.
const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'FixtureAdmin', password: 'synthetic-fixture-password' }),
});
assert.ok([200, 409].includes(setup.status), 'fixture account setup');
const headers = { Authorization: `Bearer ${fs.readFileSync('/data/access.token', 'utf8').trim()}` };
const db = new Database(
  fs.existsSync('/data/users/1/bunko.db') ? '/data/users/1/bunko.db' : '/data/bunko.db',
);
const works = Array.from({ length: 100 }, (_, i) => ({
  id: `anilist:${i + 1}`,
  adult: false,
  title: `Profile ${i + 1}`,
  type: 'MANGA',
  altTitles: [],
  anilistId: i + 1,
  mangadexId: null,
  mangaUpdatesId: null,
  coverUrl: 'https://s4.anilist.co/cover.jpg',
  bannerUrl: 'https://s4.anilist.co/banner.jpg',
  synopsis: null,
  genres: ['Action'],
  authors: [],
  score: null,
  status: null,
  chapters: null,
  episodes: null,
  webUrl: null,
  providers: ['anilist'],
  sources: [],
  trackedId: null,
  kavitaSeriesId: null,
  kavita: null,
  format: 'MANGA',
  origin: 'JP',
  year: null,
  volumes: null,
  color: null,
  popularity: null,
  startDate: null,
}));
function cache(key, value) {
  const payload = JSON.stringify(value);
  db.prepare('INSERT OR REPLACE INTO metadata_cache VALUES(?,?,?,?,?)').run(
    key,
    payload,
    payload.length,
    Date.now(),
    Date.now(),
  );
}
db.transaction(() => {
  const tracked = db.prepare(
    'INSERT INTO tracked_media(id,anilist_id,title,type,created_at,media_json,sources_json) VALUES(?,?,?,?,?,?,?)',
  );
  const observed = db.prepare('INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name) VALUES(?,?,?,?,?)');
  const release = db.prepare('INSERT INTO chapter_releases VALUES(?,?,?)');
  for (const [i, media] of works.entries()) {
    tracked.run(
      i + 1,
      i + 1,
      media.title,
      'MANGA',
      new Date().toISOString(),
      JSON.stringify(media),
      '[]',
    );
    for (let c = 0; c < 50; c++) observed.run(i + 1, i * 1000 + c, c, '1', 'Fixture');
    for (let c = 0; c < 300; c++) {
      const date = new Date(Date.now() - (c % 29) * 86400000 - c * 1000).toISOString();
      const r = {
        id: `mangadex:${i}:${c}`,
        media,
        chapter: c,
        volume: null,
        label: `c.${c}`,
        group: null,
        releasedAt: date,
        hasTime: true,
        provider: 'mangadex',
        trackedId: i + 1,
      };
      release.run(r.id, date, JSON.stringify(r));
    }
  }
  db.prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)').run(
    'release_refresh',
    String(Date.now()),
  );
  cache('home:top:false', works.slice(0, 20));
  cache(
    'discover:' +
      JSON.stringify({
        page: 1,
        perPage: 24,
        sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
        adult: false,
      }),
    {
      Page: {
        pageInfo: { hasNextPage: true },
        media: works.slice(0, 24).map((m) => ({
          id: m.anilistId,
          type: 'MANGA',
          format: 'MANGA',
          title: { english: m.title },
          coverImage: {},
          bannerImage: null,
        })),
      },
    },
  );
})();
async function api(path) {
  const r = await fetch(base + path, { headers });
  assert.equal(r.status, 200, path);
  return r.json();
}
const result = { storedReleases: 30000, followed: 100, observed: 5000, samples: 12 };
for (const name of ['home', 'releases', 'planning', 'tracked', 'discover']) {
  const at = performance.now();
  await api(`/api/${name}`);
  const coldMs = performance.now() - at;
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await api(`/api/${name}`);
    samples.push(performance.now() - start);
  }
  result[name] = {
    coldMs,
    warmMeanMs: samples.reduce((a, b) => a + b) / samples.length,
    warmMaxMs: Math.max(...samples),
  };
}
const first = await api('/api/releases');
const cursorSamples = [];
for (let i = 0; i < 12; i++) {
  const start = performance.now();
  await api(`/api/releases?cursor=${encodeURIComponent(first.nextCursor)}`);
  cursorSamples.push(performance.now() - start);
}
result.cursor = {
  warmMeanMs: cursorSamples.reduce((a, b) => a + b) / cursorSamples.length,
  warmMaxMs: Math.max(...cursorSamples),
};
db.prepare('UPDATE tracked_media SET title=title WHERE id=1').run();
const start = performance.now();
await api('/api/releases');
result.afterLibraryWriteMs = performance.now() - start;
console.log(JSON.stringify(result, null, 2));
db.close();
