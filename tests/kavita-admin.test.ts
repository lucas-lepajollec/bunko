import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-admin-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { kavitaAdmin, scanKavitaFolder } = await import('@/lib/kavita-client');
const { GET } = await import('@/app/api/status/route');
let roles: unknown;
let claim = 'role';
let probes: number;
let scanStatus: number;
let scanBody: string;
let requests: { url: string; init?: RequestInit }[];
beforeEach(() => {
  db().exec('DELETE FROM metadata_cache; DELETE FROM settings');
  roles = ['Admin', 'Login'];
  claim = 'role';
  probes = 0;
  requests = [];
  scanStatus = 200;
  scanBody = '';
  updateSettings({ kavitaUrl: 'http://kavita.fixture', kavitaApiKey: 'synthetic-private-key' });
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const value = String(url);
    requests.push({ url: value, init });
    if (value.includes('/api/Plugin/authenticate')) {
      probes++;
      return Response.json({
        token: `header.${Buffer.from(JSON.stringify({ [claim]: roles })).toString('base64url')}.signature`,
      });
    }
    if (value.includes('/api/Library/scan-folder'))
      return new Response(scanBody, { status: scanStatus });
    return Response.json({});
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
it.each([
  ['Admin', true],
  [['Login', 'Admin'], true],
  [['Login', 'Pleb'], false],
  [undefined, null],
])('detects roles %j as %s and caches the result across requests', async (value, expected) => {
  roles = value;
  expect(await kavitaAdmin()).toBe(expected);
  expect(await kavitaAdmin()).toBe(expected);
  expect(probes).toBe(1);
  const response = await GET(
    new Request('http://bunko.fixture/api/status', {
      headers: { Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}` },
    }),
  );
  expect(await response.json()).toMatchObject({ kavita: { state: 'ok', admin: expected } });
  expect(probes).toBe(1);
});
it('supports the URI role claim and invalidates cache when the configured key changes', async () => {
  claim = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';
  expect(await kavitaAdmin()).toBe(true);
  roles = ['Pleb'];
  updateSettings({ kavitaApiKey: 'other-synthetic-key' });
  expect(await kavitaAdmin()).toBe(false);
  expect(probes).toBe(2);
});
it('returns unknown when plugin authentication fails and rechecks after ten minutes', async () => {
  const fetcher = globalThis.fetch;
  vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
  expect(await kavitaAdmin()).toBeNull();
  db().prepare('UPDATE metadata_cache SET updated_at=0,attempted_at=0').run();
  vi.stubGlobal('fetch', fetcher);
  await kavitaAdmin();
  await vi.waitFor(() => expect(probes).toBe(1));
  await vi.waitFor(async () => expect(await kavitaAdmin()).toBe(true));
});
it('sends ScanFolderDto with the private key and namespace folder, without depending on headers', async () => {
  await scanKavitaFolder('/books/Manga/Fixture');
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({
    apiKey: 'synthetic-private-key',
    folderPath: '/books/Manga/Fixture',
  });
  expect(requests[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
});
it.each([
  [400, 'API key must belong to an admin', 'KAVITA_NOT_ADMIN'],
  [403, '', 'KAVITA_NOT_ADMIN'],
  [400, 'bad path synthetic-private-key', 'KAVITA_SCAN_ERROR'],
  [503, 'private server details', 'KAVITA_SCAN_ERROR'],
])('maps scan HTTP %s to safe %s', async (status, body, code) => {
  scanStatus = status;
  scanBody = body;
  await expect(scanKavitaFolder('/books/Fixture')).rejects.toMatchObject({
    code,
    message: expect.not.stringContaining('synthetic-private-key'),
  });
});
