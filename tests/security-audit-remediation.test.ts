import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nextConfig from '../next.config';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-sec-audit-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'data');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
delete process.env.BUNKO_SETUP_CODE;
delete process.env.BUNKO_TRUST_PROXY;
delete process.env.BUNKO_SECURE_COOKIES;

const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant } = await import('@/lib/tenant-context');
const { closeTenant, db, track } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret, updateSettings } = await import('@/lib/settings');
const { readResponseCapped } = await import('@/lib/translations');
const { newsPage } = await import('@/lib/news');
const authLib = await import('@/lib/auth');
const authRoute = await import('@/app/api/auth/route');
const setupRoute = await import('@/app/api/auth/setup/route');
const usersRoute = await import('@/app/api/users/route');
const settingsRoute = await import('@/app/api/settings/route');
const mediaAdultRoute = await import('@/app/api/media/adult/route');
const bulkRoute = await import('@/app/api/tracked/bulk/route');
const unlinkedRoute = await import('@/app/api/unlinked/route');
const jellyfinStreamRoute = await import('@/app/api/jellyfin/stream/[...path]/route');
const stashStreamRoute = await import('@/app/api/stash/stream/[id]/[[...rest]]/route');

const base = 'http://audit.test:2512';
const adminPassword = 'synthetic-audit-admin-pass';
const memberPassword = 'synthetic-audit-member-pass';

let adminCookie = '';
let memberCookie = '';
let memberId = 0;
let upstreamServer: Server;
let upstreamBase = '';
let rssHits = 0;

function req(
  pathname: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
  originBase = base,
) {
  return new Request(`${originBase}${pathname}`, {
    method,
    headers: {
      Origin: originBase,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  upstreamServer = createServer((request, response) => {
    const url = new URL(request.url!, 'http://upstream.local');
    if (url.pathname === '/rss') {
      rssHits++;
      response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      response.end('<rss><channel><title>Private RSS</title></channel></rss>');
      return;
    }
    if (url.pathname.startsWith('/Videos/') && url.pathname.endsWith('/evil.html')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<script>alert(1)</script>');
      return;
    }
    if (url.pathname.startsWith('/Videos/') && url.pathname.endsWith('/sub.vtt')) {
      response.writeHead(200, { 'Content-Type': 'text/vtt' });
      response.end('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n');
      return;
    }
    if (url.pathname === '/scene/42/stream.m3u8/evil.ts') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg onload="alert(1)"/>');
      return;
    }
    if (url.pathname === '/scene/42/stream.m3u8') {
      response.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(9 * 1024 * 1024),
      });
      response.end('#EXTM3U\n');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const addr = upstreamServer.address() as import('node:net').AddressInfo;
  upstreamBase = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  delete process.env.BUNKO_TRUST_PROXY;
  delete process.env.BUNKO_SECURE_COOKIES;
  delete process.env.BUNKO_VIDEO_ALLOWED_HOSTS;
  accountsDb().prepare('DELETE FROM login_attempts').run();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  for (const id of [1, 2, 3, 4]) closeTenant(id);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});

describe('P1.1 global HTTP security headers', () => {
  it('declares defensive headers in next.config.ts while keeping SAMEORIGIN for EPUB reader', async () => {
    const rules = await nextConfig.headers!();
    const globalRule = rules.find((r) => r.source === '/(.*)');
    expect(globalRule).toBeDefined();
    const map = Object.fromEntries(globalRule!.headers.map((h) => [h.key, h.value]));
    expect(map['X-Content-Type-Options']).toBe('nosniff');
    expect(map['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(map['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(map['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(map['Content-Security-Policy']).toContain("frame-ancestors 'self'");
    expect(map['Content-Security-Policy']).toContain("object-src 'none'");
    expect(map['Content-Security-Policy']).toContain("base-uri 'self'");
  });
});

describe('P2.6 first-start setup code & P2.7 separate session.key', () => {
  it('generates /data/setup.code (0600), enforces it on first setup, deletes it, and signs cookies with session.key', async () => {
    // Trigger initial accountsDb creation
    const state = await authRoute.GET(req('/api/auth'));
    expect(await state.json()).toMatchObject({ authenticated: false, setupRequired: true });

    const codeFile = path.join(directory, 'data', 'setup.code');
    expect(existsSync(codeFile)).toBe(true);
    expect(statSync(codeFile).mode & 0o777).toBe(0o600);
    const setupCode = readFileSync(codeFile, 'utf8').trim();
    expect(setupCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // Missing or invalid setup code is rejected before hashing
    const noCode = await setupRoute.POST(
      req('/api/auth/setup', 'POST', { username: 'AuditAdmin', password: adminPassword }),
    );
    expect(noCode.status).toBe(401);
    expect(await noCode.json()).toMatchObject({ error: { code: 'SETUP_CODE_INVALID' } });

    const badCode = await setupRoute.POST(
      req('/api/auth/setup', 'POST', {
        username: 'AuditAdmin',
        password: adminPassword,
        setupCode: 'AAAA-BBBB-CCCC',
      }),
    );
    expect(badCode.status).toBe(401);

    // Normalized (lowercase without hyphens) valid code succeeds and removes setup.code
    const ok = await setupRoute.POST(
      req('/api/auth/setup', 'POST', {
        username: 'AuditAdmin',
        password: adminPassword,
        setupCode: setupCode.toLowerCase().replaceAll('-', ''),
      }),
    );
    expect(ok.status).toBe(200);
    expect(existsSync(codeFile)).toBe(false);
    adminCookie = ok.headers.get('set-cookie')!.split(';')[0];

    // Verify session.key is distinct from access.token and access.token cannot sign cookies
    const sessionKey = persistentSecret('session.key', 32).toString('hex');
    const accessToken = persistentSecret('access.token', 32).toString('hex');
    expect(sessionKey).not.toBe(accessToken);

    const adminRow = accountsDb().prepare('SELECT session_epoch FROM users WHERE id=1').get() as {
      session_epoch: string;
    };
    const payload = `v2.1.${Date.now() + 3600_000}.${adminRow.session_epoch}`;
    const forgedSig = createHmac('sha256', accessToken).update(payload).digest('hex');
    expect(() =>
      authLib.authenticate(
        new Request(base, { headers: { Cookie: `bunko_session=${payload}.${forgedSig}` } }),
      ),
    ).toThrow('Authentication');

    // Bearer access.token continues to authenticate API automation
    expect(
      authLib.authenticate(
        new Request(base, { headers: { Authorization: `Bearer ${accessToken}` } }),
      ).id,
    ).toBe(1);
  });
});

describe('P1.2 proxy Secure cookies & Sec-Fetch-Site CSRF protection', () => {
  it('sets Secure on login and logout cookies when BUNKO_TRUST_PROXY or BUNKO_SECURE_COOKIES is enabled', async () => {
    // Plain HTTP without proxy trust: ignores spoofed X-Forwarded-Proto
    const spoofed = await authRoute.POST(
      req(
        '/api/auth',
        'POST',
        { username: 'AuditAdmin', password: adminPassword },
        { 'X-Forwarded-Proto': 'https' },
      ),
    );
    expect(spoofed.status).toBe(200);
    expect(spoofed.headers.get('set-cookie')).not.toContain('; Secure');

    // With BUNKO_TRUST_PROXY=true and X-Forwarded-Proto: https, http -> Secure on login & logout
    process.env.BUNKO_TRUST_PROXY = 'true';
    const proxiedLogin = await authRoute.POST(
      req(
        '/api/auth',
        'POST',
        { username: 'AuditAdmin', password: adminPassword },
        { 'X-Forwarded-Proto': 'https, http' },
      ),
    );
    expect(proxiedLogin.status).toBe(200);
    expect(proxiedLogin.headers.get('set-cookie')).toContain('; Secure');

    const proxiedLogout = await authRoute.DELETE(
      req('/api/auth', 'DELETE', undefined, {
        Cookie: adminCookie,
        'X-Forwarded-Proto': 'https',
      }),
    );
    expect(proxiedLogout.status).toBe(204);
    expect(proxiedLogout.headers.get('set-cookie')).toContain('; Secure');

    // With BUNKO_SECURE_COOKIES=true -> Secure even on plain HTTP without proxy headers
    delete process.env.BUNKO_TRUST_PROXY;
    process.env.BUNKO_SECURE_COOKIES = 'true';
    const forcedLogout = await authRoute.DELETE(
      req('/api/auth', 'DELETE', undefined, { Cookie: adminCookie }),
    );
    expect(forcedLogout.status).toBe(204);
    expect(forcedLogout.headers.get('set-cookie')).toContain('; Secure');
  });

  it('rejects Sec-Fetch-Site: cross-site on cookie mutations while allowing Bearer automation', async () => {
    const crossSiteCookie = await settingsRoute.PATCH(
      req(
        '/api/settings',
        'PATCH',
        { updateIntervalMinutes: 25 },
        { Cookie: adminCookie, 'Sec-Fetch-Site': 'cross-site' },
      ),
    );
    expect(crossSiteCookie.status).toBe(403);

    const token = persistentSecret('access.token', 32).toString('hex');
    const bearerMutation = await settingsRoute.PATCH(
      req(
        '/api/settings',
        'PATCH',
        { updateIntervalMinutes: 25 },
        { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'cross-site' },
      ),
    );
    expect(bearerMutation.status).toBe(200);
  });
});

describe('P1.4 least-privilege member defaults & P1.3 adult permission bypass fixes', () => {
  it('defaults new members to least privilege and blocks all 4 adult bypass endpoints', async () => {
    const createdRes = await usersRoute.POST(
      req(
        '/api/users',
        'POST',
        { username: 'AuditMember', password: memberPassword, role: 'member' },
        { Cookie: adminCookie },
      ),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: number; permissions: string[] };
    memberId = created.id;
    expect(created.permissions).toEqual(['downloads', 'translate']);

    const loginRes = await authRoute.POST(
      req('/api/auth', 'POST', { username: 'AuditMember', password: memberPassword }),
    );
    expect(loginRes.status).toBe(200);
    memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    // Seed a tracked work and an adult extension section in the member's tenant
    let trackedId = 0;
    inTenant(memberId, () => {
      trackedId = track({
        media: { ...emptyMedia('anilist:501', 'Sample Manga', 'MANGA'), anilistId: 501 },
        status: 'READING',
      }).id;
      db()
        .prepare(
          "INSERT INTO extension_sections(id,name,adult,addons,position) VALUES('adult-sec','Adult Sec',1,'[]',0)",
        )
        .run();
    });

    // 1. PATCH /api/media/adult -> 403
    const rAdultOverride = await mediaAdultRoute.PATCH(
      req(
        '/api/media/adult',
        'PATCH',
        { id: 'anilist:501', adult: false },
        { Cookie: memberCookie },
      ),
    );
    expect(rAdultOverride.status).toBe(403);
    expect(await rAdultOverride.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    // 2. POST /api/tracked/bulk (adult & notAdult) -> 403
    for (const action of ['adult', 'notAdult'] as const) {
      const rBulk = await bulkRoute.POST(
        req(
          '/api/tracked/bulk',
          'POST',
          { ids: [trackedId], action },
          { Cookie: memberCookie },
        ),
      );
      expect(rBulk.status).toBe(403);
      expect(await rBulk.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    }

    // 3. PATCH /api/settings (adultContent, adultMode, hideNsfwSources: false) -> 403
    for (const patch of [
      { adultContent: true },
      { adultContent: false },
      { adultMode: true },
      { adultMode: false },
      { hideNsfwSources: false },
    ]) {
      const rSettings = await settingsRoute.PATCH(
        req('/api/settings', 'PATCH', patch, { Cookie: memberCookie }),
      );
      expect(rSettings.status, JSON.stringify(patch)).toBe(403);
      expect(await rSettings.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    }
    // Setting hideNsfwSources: true remains permitted
    expect(
      (
        await settingsRoute.PATCH(
          req('/api/settings', 'PATCH', { hideNsfwSources: true }, { Cookie: memberCookie }),
        )
      ).status,
    ).toBe(200);

    // 4. POST /api/unlinked (adult: true OR adult extension section) -> 403
    const rUnlinkedAdult = await unlinkedRoute.POST(
      req(
        '/api/unlinked',
        'POST',
        {
          integration: 'jellyfin',
          id: 'item1',
          kind: 'anime',
          title: 'Unlinked Item',
          adult: true,
        },
        { Cookie: memberCookie },
      ),
    );
    expect(rUnlinkedAdult.status).toBe(403);
    expect(await rUnlinkedAdult.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    const rUnlinkedSection = await unlinkedRoute.POST(
      req(
        '/api/unlinked',
        'POST',
        {
          integration: 'jellyfin',
          id: 'item1',
          kind: 'extension',
          title: 'Unlinked Section Item',
          section: { id: 'adult-sec', name: 'Adult Sec' },
        },
        { Cookie: memberCookie },
      ),
    );
    expect(rUnlinkedSection.status).toBe(403);
    expect(await rUnlinkedSection.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  });
});

describe('P2.7 per-IP / direct fallback rate limit against username spray', () => {
  it('caps random-username spraying per IP when BUNKO_TRUST_PROXY=true without locking out other IPs', async () => {
    process.env.BUNKO_TRUST_PROXY = 'true';
    for (let i = 0; i < 30; i++) {
      const res = await authRoute.POST(
        req(
          '/api/auth',
          'POST',
          { username: `spray${i}`, password: 'wrong-password-123' },
          { 'X-Forwarded-For': '203.0.113.10' },
        ),
      );
      expect(res.status).toBe(401);
    }
    const blocked = await authRoute.POST(
      req(
        '/api/auth',
        'POST',
        { username: 'spray30', password: 'wrong-password-123' },
        { 'X-Forwarded-For': '203.0.113.10' },
      ),
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    // A different client IP is unaffected
    const otherIp = await authRoute.POST(
      req(
        '/api/auth',
        'POST',
        { username: 'AuditAdmin', password: adminPassword },
        { 'X-Forwarded-For': '203.0.113.20' },
      ),
    );
    expect(otherIp.status).toBe(200);
  }, 30_000);
});

describe('P2.8 proxy, RSS SSRF, TraDoc streaming cap & media Content-Type allowlists', () => {
  it('prevents RSS newsFeeds from probing BUNKO_VIDEO_ALLOWED_HOSTS', async () => {
    rssHits = 0;
    process.env.BUNKO_VIDEO_ALLOWED_HOSTS = '127.0.0.1';
    const result = await inTenant(1, async () => {
      updateSettings({
        newsFeeds: [{ url: `${upstreamBase}/rss`, kind: 'anime' }],
      });
      return newsPage(['anime']);
    });
    expect(rssHits).toBe(0);
    expect(result.failed).toContain(new URL(upstreamBase).host);
  });

  it('aborts oversized TraDoc responses immediately via streaming byte cap', async () => {
    let chunksSent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const fakeResponse = new Response(stream, { status: 200 });
    await expect(readResponseCapped(fakeResponse, 2048)).rejects.toMatchObject({
      code: 'TRADOC_ERROR',
    });
    expect(chunksSent).toBeLessThanOrEqual(4);
  });

  it('allowlists media Content-Type on Jellyfin and Stash stream routes and caps Stash playlists at 8 MiB', async () => {
    inTenant(1, () => {
      updateSettings({
        jellyfinUrl: upstreamBase,
        jellyfinApiKey: 'jf-key',
        stashUrl: upstreamBase,
        stashApiKey: 'stash-key',
      });
    });

    // Jellyfin: HTML downgraded to application/octet-stream, WebVTT allowed
    const jfHtml = await jellyfinStreamRoute.GET(
      req(
        '/api/jellyfin/stream/Videos/0123456789abcdef0123456789abcdef/evil.html',
        'GET',
        undefined,
        { Cookie: adminCookie },
      ),
    );
    expect(jfHtml.status).toBe(200);
    expect(jfHtml.headers.get('content-type')).toBe('application/octet-stream');
    expect(jfHtml.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    await jfHtml.body?.cancel();

    const jfVtt = await jellyfinStreamRoute.GET(
      req(
        '/api/jellyfin/stream/Videos/0123456789abcdef0123456789abcdef/sub.vtt',
        'GET',
        undefined,
        { Cookie: adminCookie },
      ),
    );
    expect(jfVtt.status).toBe(200);
    expect(jfVtt.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    await jfVtt.body?.cancel();

    // Stash: SVG downgraded to application/octet-stream; >8 MiB playlist rejected
    const stashSvg = await stashStreamRoute.GET(
      req('/api/stash/stream/42/stream.m3u8/evil.ts', 'GET', undefined, { Cookie: adminCookie }),
    );
    expect(stashSvg.status).toBe(200);
    expect(stashSvg.headers.get('content-type')).toBe('application/octet-stream');
    expect(stashSvg.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    await stashSvg.body?.cancel();

    const stashHugePlaylist = await stashStreamRoute.GET(
      req('/api/stash/stream/42/stream.m3u8', 'GET', undefined, { Cookie: adminCookie }),
    );
    expect(stashHugePlaylist.status).toBe(502);
    expect(await stashHugePlaylist.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
});
