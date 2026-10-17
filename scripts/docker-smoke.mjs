// Run inside the disposable Compose test container; credentials stay in process memory.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const base = 'http://127.0.0.1:2512';
for (let attempt = 0; attempt < 30 && !existsSync('/data/access.token'); attempt++)
  await setTimeout(1000);
const token = readFileSync('/data/access.token', 'utf8').trim();
const get = (path, extra = {}) =>
  fetch(`${base}${path}`, {
    ...extra,
    headers: { Authorization: `Bearer ${token}`, ...extra.headers },
  });
const json = (method, value) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
assert.equal((await fetch(`${base}/api/health`)).status, 200);
assert.equal((await fetch(`${base}/api/settings`)).status, 401);
const credentials = { username: 'SmokeAdmin', password: 'synthetic-smoke-password' };
const authPost = (path, value, origin = base) =>
  fetch(`${base}${path}`, {
    ...json('POST', value),
    headers: { 'Content-Type': 'application/json', Origin: origin },
  });
assert.deepEqual(await (await fetch(`${base}/api/auth`)).json(), {
  authenticated: false,
  setupRequired: true,
  username: null,
  userId: null,
  role: null,
});
assert.equal(
  (await authPost('/api/auth/setup', credentials, 'https://invalid.example')).status,
  403,
);
assert.equal((await authPost('/api/auth', credentials, 'https://invalid.example')).status, 403);
assert.equal((await authPost('/api/auth', credentials)).status, 409);
assert.equal((await authPost('/api/auth/setup', credentials)).status, 200);
assert.equal((await authPost('/api/auth/setup', credentials)).status, 409);
assert.equal(
  (await authPost('/api/auth', { ...credentials, password: 'wrong-password' })).status,
  401,
);
const login = await authPost('/api/auth', credentials);
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.equal((await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).status, 200);
assert.equal(
  (
    await get('/api/settings', {
      ...json('PATCH', {}),
      headers: { 'Content-Type': 'application/json', Origin: 'https://invalid.example' },
    })
  ).status,
  403,
);
for (const path of [
  '/api/settings',
  '/api/sources',
  '/api/extensions?lang=fr',
  '/api/downloads',
  '/api/downloads/batches',
  '/api/tracked',
]) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  await response.json();
}
assert.equal((await get('/api/settings', json('PATCH', { extensionRepos: [] }))).status, 200);
assert.equal(
  (await get('/api/extensions/action', json('POST', { action: 'refresh' }))).status,
  200,
);
assert.equal((await get('/api/search?q=')).status, 400);
assert.equal((await get('/api/arr/releases?query=Example')).status, 409);
assert.equal((await get('/api/manga/chapters')).status, 400);
const deep = await get('/api/search/stream?q=Example');
assert.equal(deep.headers.get('content-type'), 'text/event-stream; charset=utf-8');
assert.match(await deep.text(), /event: done/);
const sync = await get('/api/catalog/sync', json('POST', { pages: 1 }));
assert.match(await sync.text(), /event: done/);
const stream = await get('/api/downloads/stream');
const reader = stream.body.getReader();
const first = await reader.read();
assert.match(new TextDecoder().decode(first.value), /event: snapshot/);
await reader.cancel();
// Metadata providers are live; partial or unavailable providers are explicit in the response.
const search = await get('/api/search?q=Yotsuba&type=MANGA');
assert.equal(search.status, 200);
const result = await search.json();
assert.ok(Array.isArray(result.results));
assert.equal(result.providers.length, 4);
console.log(
  JSON.stringify({
    status: 'passed',
    checks: 26,
    providers: result.providers,
    results: result.results.length,
  }),
);
