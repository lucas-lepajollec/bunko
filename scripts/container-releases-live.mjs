// Executed inside the built image by container-releases-live.sh, never against host data.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';
const base = 'http://127.0.0.1:2512';
for (let attempt = 0; attempt < 60; attempt++) {
  if (
    await fetch(`${base}/api/health`)
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await delay(1000);
}
// Authentication material stays in process memory and is never included in output.
const headers = { Authorization: `Bearer ${fs.readFileSync('/data/access.token', 'utf8').trim()}` };
async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `API status for ${path.split('?')[0]}`);
  return response.json();
}
const started = Date.now();
await api('/api/releases');
const firstResponseMs = Date.now() - started;
const database = new Database('/data/bunko.db', { readonly: true });
let firstStoredMuMs;
let result;
let lastProgress = 0;
while (Date.now() - started < Number(process.env.LIVE_TIMEOUT) * 1000) {
  const count = database
    .prepare("SELECT COUNT(*) n FROM chapter_releases WHERE id LIKE 'mangaupdates:%'")
    .get().n;
  if (count && firstStoredMuMs === undefined) {
    firstStoredMuMs = Date.now() - started;
    console.log(JSON.stringify({ firstStoredMuMs, count }));
  }
  const row = database
    .prepare("SELECT value FROM worker_state WHERE key='release_refresh_result'")
    .get();
  if (row) {
    result = JSON.parse(row.value);
    break;
  }
  if (Date.now() - lastProgress > 30_000) {
    console.log(JSON.stringify({ elapsedMs: Date.now() - started, storedMangaUpdates: count }));
    lastProgress = Date.now();
  }
  await delay(1000);
}
assert.ok(result, 'First refresh must complete before LIVE_TIMEOUT');
const rows = database
  .prepare('SELECT payload FROM chapter_releases')
  .all()
  .map((r) => JSON.parse(r.payload));
const kind = (m) =>
  m.type === 'NOVEL'
    ? 'novel'
    : m.format === 'MANHWA' || m.origin === 'KR'
      ? 'manhwa'
      : m.format === 'MANHUA' || ['CN', 'HK', 'TW'].includes(m.origin)
        ? 'manhua'
        : 'manga';
function counts(items) {
  const provider = {},
    kinds = {},
    providerKind = {};
  for (const r of items) {
    provider[r.provider] = (provider[r.provider] ?? 0) + 1;
    kinds[kind(r.media)] = (kinds[kind(r.media)] ?? 0) + 1;
    const key = `${r.provider}/${kind(r.media)}`;
    providerKind[key] = (providerKind[key] ?? 0) + 1;
  }
  return { total: items.length, provider, kinds, providerKind };
}
async function feed() {
  const items = [],
    seen = new Set();
  let cursor;
  do {
    const page = await api(`/api/releases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.items) {
      assert.ok(!seen.has(item.id), 'No duplicated release between pages');
      seen.add(item.id);
      items.push(item);
    }
    cursor = page.nextCursor;
    assert.ok(items.length <= 30_000, 'Pagination must terminate');
  } while (cursor);
  return items;
}
const defaultFeed = await feed();
await api('/api/settings', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adultContent: true }),
});
const allFeed = await feed();
assert.ok(
  allFeed.some((r) => r.provider === 'mangaupdates'),
  'MangaUpdates must be visible in paged API',
);
assert.ok(
  rows.some((r) => r.provider === 'mangaupdates' && r.hasTime),
  'MangaUpdates timestamps must persist',
);
assert.ok(
  defaultFeed.every((r) => !r.media.adult),
  'Adult filter applies',
);
for (let i = 1; i < allFeed.length; i++)
  assert.ok(
    Date.parse(allFeed[i - 1].releasedAt) >= Date.parse(allFeed[i].releasedAt),
    'Providers sort by timestamp',
  );
const novels = await api('/api/releases?kind=novel');
const home = await api('/api/home');
const planning = await api('/api/planning');
assert.equal(planning.days.length, 7);
if (allFeed.some((r) => kind(r.media) === 'novel')) {
  assert.ok(novels.items.length > 0, 'Novel filter returns available novels');
  assert.ok(home.latest.novel.length > 0, 'Home includes available novels');
}
console.log(
  JSON.stringify(
    {
      firstResponseMs,
      firstStoredMuMs,
      refreshMs: result.at - started,
      refreshFailed: result.failed,
      stored: counts(rows),
      defaultFeed: counts(defaultFeed),
      adultEnabledFeed: counts(allFeed),
      storedAdult: rows.filter((r) => r.media.adult).length,
      mangaUpdatesTimed: rows.filter((r) => r.provider === 'mangaupdates' && r.hasTime).length,
      novelApi: novels.items.length,
      homeLatestNovel: home.latest.novel.length,
    },
    null,
    2,
  ),
);
database.close();
