// Real HTTP between independently compiled Next route bundles; all state is disposable.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
const base = 'http://127.0.0.1:2512';
for (let i = 0; i < 60; i++) {
  if (
    await fetch(`${base}/api/health`)
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
async function api(path, body) {
  const r = await fetch(base + path, {
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    method: body ? 'PATCH' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(r.status, 200, path);
  return r.json();
}
const db = new Database(
  fs.existsSync('/data/users/1/bunko.db') ? '/data/users/1/bunko.db' : '/data/bunko.db',
);
const normal = {
  id: 'anilist:1',
  adult: false,
  title: 'Fixture Story',
  type: 'MANGA',
  altTitles: [],
  anilistId: 1,
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
};
const adult = { ...normal, id: 'anilist:2', anilistId: 2, title: 'Fixture Adult', adult: true };
const now = new Date().toISOString();
const sources = [{ sourceId: '9223372036854775806', sourceName: 'NSFW scan', suwayomiMangaId: 10 }];
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
  db.prepare('INSERT INTO source_flags VALUES(?,1)').run(sources[0].sourceId);
  for (const [i, media] of [normal, adult].entries()) {
    db.prepare(
      'INSERT INTO tracked_media(id,anilist_id,title,type,created_at,media_json,sources_json) VALUES(?,?,?,?,?,?,?)',
    ).run(
      i + 1,
      i + 1,
      media.title,
      media.type,
      now,
      JSON.stringify(media),
      JSON.stringify(sources),
    );
    db.prepare('INSERT INTO update_entries VALUES(?,?,?,?,?)').run(
      i + 1,
      i + 1,
      sources[0].sourceId,
      'Scan',
      now,
    );
    db.prepare('INSERT INTO update_chapters(entry_id,chapter_id,number) VALUES(?,?,?)').run(
      i + 1,
      501 + i,
      501 + i,
    );
    const r = {
      id: `mangadex:${i}`,
      media,
      chapter: 1,
      volume: null,
      label: 'c.1',
      group: null,
      releasedAt: now,
      hasTime: true,
      provider: 'mangadex',
      trackedId: i + 1,
    };
    db.prepare('INSERT INTO chapter_releases VALUES(?,?,?)').run(r.id, now, JSON.stringify(r));
  }
  db.prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)').run(
    'release_refresh',
    String(Date.now()),
  );
  for (const mode of [false, true]) {
    cache(`home:top:${mode}`, [normal, adult]);
    const variables = {
      page: 1,
      perPage: 24,
      sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
      ...(mode ? {} : { adult: false }),
    };
    cache(`discover:${JSON.stringify(variables)}`, {
      Page: {
        pageInfo: { hasNextPage: false },
        media: [normal, adult].map((m) => ({
          id: m.anilistId,
          type: 'MANGA',
          format: 'MANGA',
          title: { english: m.title },
          isAdult: m.adult,
          coverImage: {},
          bannerImage: m.bannerUrl,
        })),
      },
    });
    for (const type of ['MANGA', undefined])
      for (const provider of ['anilist', 'mangadex', 'mangaupdates'])
        cache(`search:${provider}:${mode}:${type}:fixture`, [normal, adult]);
  }
})();
const rows = [];
for (const mode of [false, true, false, true]) {
  await api('/api/settings', { adultContent: mode });
  const tracked = await api('/api/tracked');
  const discover = await api('/api/discover');
  const search = await api('/api/search?q=Fixture&type=MANGA');
  const quick = await api('/api/search?q=Fixture'); // Exact URL used by QuickSearch.
  const releases = await api('/api/releases');
  const home = await api('/api/home');
  const planning = await api('/api/planning');
  const activity = await api('/api/library/activity');
  const updates = await api('/api/updates');
  const row = {
    mode,
    tracked: tracked.length,
    discover: discover.items.length,
    search: search.results.length,
    quick: quick.results.length,
    releases: releases.items.length,
    top: home.top.length,
    hero: home.hero.length,
    planning: planning.days.flatMap((d) => d.items).length,
    hiddenAdult: activity.hiddenAdult,
    updates: updates.entries.length,
  };
  rows.push(row);
  if (!process.env.L3_BEFORE) {
    const count = mode ? 2 : 1;
    for (const name of [
      'tracked',
      'discover',
      'search',
      'quick',
      'releases',
      'top',
      'hero',
      'planning',
      'updates',
    ])
      assert.equal(row[name], count, `${name}, adult=${mode}`);
    assert.equal(row.hiddenAdult, mode ? 0 : 1);
    assert.ok(
      home.hero.every((r) => r.media.bannerUrl),
      'Hero banners survive enrichment',
    );
  }
}
if (!process.env.L3_BEFORE) {
  // Observation time is today; only the independently persisted upload date is valid.
  const dates = [null, '2019-01-01T00:00:00.000Z', new Date(Date.now() - 3600000).toISOString()];
  for (const [i, uploaded] of dates.entries()) {
    const chapterId = 601 + i;
    db.prepare('INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name) VALUES(?,?,?,?,?)').run(
      1,
      chapterId,
      chapterId,
      sources[0].sourceId,
      'Scan',
    );
    db.prepare(
      'INSERT INTO observation_dates(tracked_id,chapter_id,at,uploaded_at) VALUES(?,?,?,?)',
    ).run(1, chapterId, now, uploaded);
  }
  const sourceRows = (await api('/api/releases')).items.filter((r) => r.provider === 'source');
  assert.deepEqual(
    sourceRows.map((r) => r.chapter),
    [603],
    'Only recent upload appears; observation date never releases a chapter',
  );
  assert.equal(sourceRows[0].releasedAt, dates[2]);
  const actual = (await api('/api/planning')).days
    .flatMap((d) => d.items)
    .filter((r) => r.chapter >= 601);
  assert.deepEqual(
    actual.map((r) => r.chapter),
    [603],
    'Planning uses the same source upload provenance',
  );
}
console.log(
  JSON.stringify({ imageMode: process.env.L3_BEFORE || 'fixed', visibility: rows }, null, 2),
);
db.close();
