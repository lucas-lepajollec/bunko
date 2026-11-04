import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';

// A name that resolves to a private address (DNS rebinding, internal names): the socket's own
// lookup must refuse it even though the name looks public.
vi.mock('node:dns', async (original) => {
  const dns = await original<typeof import('node:dns')>();
  const lookup = ((host: string, options: unknown, callback: (...a: unknown[]) => void) => {
    const fixed: Record<string, string> = {
      'rebind.example': '10.0.0.7',
      'metadata.example': '169.254.169.254',
      'v6local.example': 'fd00::1',
    };
    if (fixed[host]) {
      const address = fixed[host];
      const family = address.includes(':') ? 6 : 4;
      return (options as { all?: boolean }).all
        ? callback(null, [{ address, family }])
        : callback(null, address, family);
    }
    return (dns.lookup as unknown as (...a: unknown[]) => void)(host, options, callback);
  }) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-safe-fetch-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const net = await import('@/lib/safe-fetch');
const relay = await import('@/lib/video-relay');
const addons = await import('@/lib/video-addons');
const { updateSettings } = await import('@/lib/settings');
const { inTenant } = await import('@/lib/tenant-context');

let calls: string[] = [];
const servers: Server[] = [];
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('node:net').AddressInfo).port;
};
let a = 0;
let b = 0;
beforeAll(async () => {
  b = await listen((req, res) => {
    calls.push(`B ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers }));
  });
  a = await listen((req, res) => {
    calls.push(`A ${req.url}`);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/to-b') {
      res.writeHead(302, { Location: `http://127.0.0.1:${b}/landed` });
      return res.end();
    }
    if (url.pathname === '/to-localhost') {
      res.writeHead(302, { Location: `http://localhost:${a}/echo` });
      return res.end();
    }
    if (url.pathname === '/to-metadata') {
      res.writeHead(301, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (url.pathname === '/to-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      return res.end();
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      return res.end();
    }
    if (url.pathname === '/huge') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(`"${'x'.repeat(5 * 1024 * 1024)}"`);
    }
    if (url.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<script>alert(1)</script>');
    }
    if (url.pathname === '/hang') return; // never answers
    if (url.pathname === '/manifest.json') {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers }));
  });
});
afterEach(() => {
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '';
  calls = [];
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(directory, { recursive: true, force: true });
});
const refused = { code: 'DESTINATION_REFUSED' };

it('classifies private and public addresses, IPv4 and IPv6', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:101::1',
    'not-an-ip',
  ])
    expect(net.isPublicAddress(address), address).toBe(false);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    expect(net.isPublicAddress(address), address).toBe(true);
});

it('refuses loopback, LAN and metadata addresses, however they are written', async () => {
  for (const url of [
    `http://127.0.0.1:${a}/`,
    `http://localhost:${a}/`,
    `http://[::1]:${a}/`,
    `http://[::ffff:127.0.0.1]:${a}/`,
    `http://2130706433:${a}/`, // 127.0.0.1 as one number
    `http://0x7f.1:${a}/`,
    `http://127.1:${a}/`,
    'http://169.254.169.254/latest/meta-data/',
    'http://rebind.example/',
    'http://metadata.example/',
    'http://v6local.example/',
  ])
    await expect(net.safeFetch(url), url).rejects.toMatchObject(refused);
  expect(calls).toEqual([]);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'http://', 'nonsense'])
    await expect(net.safeFetch(url), url).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await expect(net.safeFetch(`http://user:pw@example.com/`)).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
});

it('checks every redirect and drops credentials when leaving the origin', async () => {
  // Only server A is allowed (by host:port): its redirects must not open the rest.
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = `127.0.0.1:${a}`;
  await expect(net.safeFetch(`http://127.0.0.1:${a}/to-b`)).rejects.toMatchObject(refused);
  await expect(net.safeFetch(`http://127.0.0.1:${a}/to-localhost`)).rejects.toMatchObject(refused);
  await expect(net.safeFetch(`http://127.0.0.1:${a}/to-metadata`)).rejects.toMatchObject(refused);
  await expect(net.safeFetch(`http://127.0.0.1:${a}/to-file`)).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  await expect(net.safeFetch(`http://127.0.0.1:${a}/loop`)).rejects.toMatchObject({
    code: 'STREAM_UNREACHABLE',
  });
  expect(calls.some((c) => c.startsWith('B '))).toBe(false);
  // Both allowed: the redirect is followed, without the credentials.
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = `127.0.0.1:${a},127.0.0.1:${b}`;
  const json = (await net.safeJson(`http://127.0.0.1:${a}/to-b`, {
    headers: { Authorization: 'Bearer addon-secret', Referer: 'https://player.example/' },
  })) as { headers: Record<string, string> };
  expect(json.headers.authorization).toBeUndefined();
  expect(json.headers.referer).toBe('https://player.example/');
  expect(json.headers.cookie).toBeUndefined();
  // A CIDR allows a range.
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.0/8';
  expect(await net.safeJson(`http://127.0.0.1:${a}/echo`)).toMatchObject({ headers: {} });
});

it('caps sizes and time', async () => {
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
  await expect(net.safeJson(`http://127.0.0.1:${a}/huge`)).rejects.toMatchObject({
    code: 'PAYLOAD_TOO_LARGE',
  });
  await expect(
    net.safeFetch(`http://127.0.0.1:${a}/hang`, { timeoutMs: 200 }),
  ).rejects.toMatchObject({ code: 'STREAM_TIMEOUT' });
});

it('relays third-party bytes as opaque media, never as a page of Bunko', async () => {
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
  const path = relay.relayPath({ url: `http://127.0.0.1:${a}/page` });
  const response = await relay.relay(path.split('/').pop()!, new Request(`http://bunko${path}`));
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  await response.body?.cancel();
  // Relay links into a private network fail even when sealed by Bunko itself.
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '';
  const inside = relay.relayPath({ url: `http://127.0.0.1:${a}/echo` });
  await expect(
    relay.relay(inside.split('/').pop()!, new Request(`http://bunko${inside}`)),
  ).rejects.toMatchObject(refused);
  // Another account cannot use it.
  expect(() => inTenant(2, () => relay.unseal(inside.split('/').pop()!))).toThrow(/Unknown stream/);
});

it('refuses LAN extensions unless allowed, and rests a failing one', async () => {
  await expect(
    addons.addVideoAddon(`http://192.168.1.20:7000/manifest.json`),
  ).rejects.toMatchObject({ code: 'ADDON_PRIVATE' });
  await expect(addons.addVideoAddon(`http://nas.local/manifest.json`)).rejects.toMatchObject({
    code: 'ADDON_PRIVATE',
  });
  // An extension whose manifest fails is not asked again for every episode.
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
  updateSettings({ videoAddons: [`http://127.0.0.1:${a}/manifest.json`] });
  addons.resetStreamCache();
  await addons.imdbStreams('tt0000001', null, 'fr');
  addons.resetStreamCache();
  await addons.imdbStreams('tt0000002', null, 'fr');
  expect(calls.filter((c) => c === 'A /manifest.json')).toHaveLength(1);
  addons.resetAddonRest();
  updateSettings({ videoAddons: [] });
});

it('keeps another account out of cached episode lookups', async () => {
  process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
  const mine = await addons.imdbStreams('tt0000003', null, 'fr');
  const theirs = await inTenant(2, () => addons.imdbStreams('tt0000003', null, 'fr'));
  expect(theirs).not.toBe(mine);
  expect(theirs.streams).toEqual([]);
});
