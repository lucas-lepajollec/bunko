import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return {
    ...crypto,
    scrypt: vi.fn(crypto.scrypt),
    timingSafeEqual: vi.fn(crypto.timingSafeEqual),
  };
});
const { scrypt, timingSafeEqual } = await import('node:crypto');
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-auth-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant(false);
const { migrateV4 } = await import('@/lib/db');
const { accountsDb: db } = await import('@/lib/accounts-store');
const { persistentSecret } = await import('@/lib/settings');
const { authenticate } = await import('@/lib/auth');
const { hashPassword, verifyPassword } = await import('@/lib/passwords');
const { GET, POST, DELETE } = await import('@/app/api/auth/route');
const { POST: setup } = await import('@/app/api/auth/setup/route');
const { POST: password } = await import('@/app/api/auth/password/route');
const { GET: protectedRoute } = await import('@/app/api/settings/route');
const base = 'http://reader.test:2512';
const credentials = { username: 'Reader._-1', password: 'synthetic-password' };
let clock = Date.now();
function request(
  pathname = '/api/auth',
  value?: unknown,
  headers: HeadersInit = {},
  method?: string,
) {
  return new Request(`${base}${pathname}`, {
    method: method ?? (value === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
function cookie(response: Response) {
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
  expect(response.headers.get('set-cookie')).toBeNull();
}
beforeEach(() => {
  db().exec(
    "DELETE FROM users; DELETE FROM sqlite_sequence WHERE name='users'; DELETE FROM account_state WHERE key='token_user';",
  );
  // Advance only Date.now, leaving real asynchronous scrypt/streams intact.
  clock += 61_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.mocked(scrypt).mockClear();
  vi.mocked(timingSafeEqual).mockClear();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

describe('account routes', () => {
  it('reports public setup state, creates once, signs in and reports canonical username', async () => {
    const initial = await GET(request());
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      authenticated: false,
      setupRequired: true,
      username: null,
      userId: null,
      role: null,
    });
    await error(await POST(request('/api/auth', credentials)), 409, 'SETUP_REQUIRED');
    const created = await setup(request('/api/auth/setup', credentials));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      authenticated: true,
      setupRequired: false,
      username: credentials.username,
      userId: 1,
      role: 'admin',
    });
    expect(created.headers.get('set-cookie')).toContain(
      'HttpOnly; SameSite=Strict; Max-Age=604800',
    );
    const signedIn = await GET(request('/api/auth', undefined, { Cookie: cookie(created) }));
    expect(await signedIn.json()).toEqual({
      authenticated: true,
      setupRequired: false,
      username: credentials.username,
      userId: 1,
      role: 'admin',
    });
    const signedOut = await GET(request());
    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({
      authenticated: false,
      setupRequired: false,
      username: null,
      userId: null,
      role: null,
    });
    await error(await setup(request('/api/auth/setup', credentials)), 409, 'ALREADY_SET_UP');
    expect(db().prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    const login = await POST(
      request('/api/auth', { ...credentials, username: credentials.username.toLowerCase() }),
    );
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ username: credentials.username });
    expect(
      (await protectedRoute(request('/api/settings', undefined, { Cookie: cookie(login) }))).status,
    ).toBe(200);
    const logout = await DELETE(
      request('/api/auth', undefined, { Cookie: cookie(login) }, 'DELETE'),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('allows exactly one concurrent setup and rejects subsequent calls', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        setup(request('/api/auth/setup', { ...credentials, username: `Reader${index}` })),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const response of responses.filter((r) => r.status === 409))
      await error(response, 409, 'ALREADY_SET_UP');
    // The invariant is enforced by SQLite, independently of JS's preflight check.
    const other = new Database(path.join(directory, 'accounts.db'));
    expect(() =>
      other
        .prepare(
          "INSERT INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(1,'Other','admin','hash','epoch','today')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      other
        .prepare(
          "INSERT INTO users(username,role,password_hash,session_epoch,created_at) SELECT lower(username),'member','hash','epoch','today' FROM users LIMIT 1",
        )
        .run(),
    ).toThrow();
    other.close();
  });

  it.each([
    { username: 'ab' },
    { username: 'a'.repeat(41) },
    { username: 'with space' },
    { username: 'réader' },
    { username: 'a/b' },
    { password: 'a'.repeat(9) },
    { password: 'a'.repeat(201) },
    { password: 1234567890 },
    { token: 'old-token', password: undefined },
  ])('validates setup credentials without creating an account: %j', async (patch) => {
    await error(
      await setup(request('/api/auth/setup', { ...credentials, ...patch })),
      400,
      'VALIDATION_ERROR',
    );
    expect(db().prepare('SELECT * FROM users').get()).toBeUndefined();
    expect(scrypt).not.toHaveBeenCalled();
  });

  it('accepts username/password boundary lengths and stores salted, versioned scrypt hashes', async () => {
    const response = await setup(
      request('/api/auth/setup', { username: 'a'.repeat(40), password: 'a'.repeat(200) }),
    );
    expect(response.status).toBe(200);
    const stored = db().prepare('SELECT password_hash FROM users').get() as {
      password_hash: string;
    };
    expect(stored.password_hash).toMatch(/^scrypt\$v1\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(stored.password_hash).not.toContain('a'.repeat(200));
    const another = await hashPassword('a'.repeat(200));
    expect(another).not.toBe(stored.password_hash);
    expect(await verifyPassword('a'.repeat(200), stored.password_hash)).toBe(true);
    expect(await verifyPassword('wrong-password', stored.password_hash)).toBe(false);
    expect(await verifyPassword('wrong-password', 'malformed')).toBe(false);
    db().exec(
      "DELETE FROM users; DELETE FROM sqlite_sequence WHERE name='users'; DELETE FROM account_state WHERE key='token_user';",
    );
    expect(
      (await setup(request('/api/auth/setup', { username: 'abc', password: 'a'.repeat(10) })))
        .status,
    ).toBe(200);
  });

  it('performs the same scrypt work for an unknown user and a wrong password', async () => {
    await setup(request('/api/auth/setup', credentials));
    vi.mocked(scrypt).mockClear();
    vi.mocked(timingSafeEqual).mockClear();
    await error(
      await POST(request('/api/auth', { ...credentials, password: 'wrong-password' })),
      401,
      'INVALID_CREDENTIALS',
    );
    await error(
      await POST(request('/api/auth', { username: 'Unknown', password: 'wrong-password' })),
      401,
      'INVALID_CREDENTIALS',
    );
    expect(scrypt).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const [derived, expected] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(derived).toHaveLength(64);
      expect(expected).toHaveLength(64);
    }
    for (const call of vi.mocked(scrypt).mock.calls) {
      expect(call[0]).toBe('wrong-password');
      expect(call[1]).toHaveLength(16);
      expect(call[2]).toBe(64);
      expect(call[3]).toEqual({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    }
  });

  it('limits each username to 10/minute without a global lockout', async () => {
    await setup(request('/api/auth/setup', credentials));
    clock += 61_000;
    for (let i = 0; i < 10; i++)
      await error(
        await POST(
          request('/api/auth', {
            ...credentials,
            username: i % 2 ? credentials.username.toLowerCase() : credentials.username,
            password: 'wrong-password',
          }),
        ),
        401,
        'INVALID_CREDENTIALS',
      );
    const calls = vi.mocked(scrypt).mock.calls.length;
    await error(await POST(request('/api/auth', credentials)), 429, 'RATE_LIMITED');
    expect(scrypt).toHaveBeenCalledTimes(calls);
    // Other names are not locked out by someone hammering one account (no shared counter).
    for (let i = 0; i < 12; i++)
      await error(
        await POST(request('/api/auth', { ...credentials, username: `Unknown${i}` })),
        401,
        'INVALID_CREDENTIALS',
      );
    clock += 60_000;
    expect((await POST(request('/api/auth', credentials))).status).toBe(200);
  });

  it('rotates the password and epoch, invalidates all old cookies and reissues the current session', async () => {
    const created = await setup(request('/api/auth/setup', credentials));
    const second = await POST(request('/api/auth', credentials));
    const old = cookie(created);
    const change = { currentPassword: credentials.password, newPassword: 'replacement-password' };
    await error(await password(request('/api/auth/password', change)), 401, 'UNAUTHORIZED');
    await error(
      await password(
        request(
          '/api/auth/password',
          { ...change, currentPassword: 'wrong-password' },
          { Cookie: old },
        ),
      ),
      401,
      'INVALID_CREDENTIALS',
    );
    for (const newPassword of ['short', 'a'.repeat(201)])
      await error(
        await password(request('/api/auth/password', { ...change, newPassword }, { Cookie: old })),
        400,
        'VALIDATION_ERROR',
      );
    expect(() => authenticate(request('/api/settings', undefined, { Cookie: old }))).not.toThrow();
    const changed = await password(request('/api/auth/password', change, { Cookie: old }));
    expect(changed.status).toBe(200);
    for (const stale of [old, cookie(second)]) {
      expect(
        (await protectedRoute(request('/api/settings', undefined, { Cookie: stale }))).status,
      ).toBe(401);
      expect(await (await GET(request('/api/auth', undefined, { Cookie: stale }))).json()).toEqual({
        authenticated: false,
        setupRequired: false,
        username: null,
        userId: null,
        role: null,
      });
    }
    expect(
      (await protectedRoute(request('/api/settings', undefined, { Cookie: cookie(changed) })))
        .status,
    ).toBe(200);
    await error(await POST(request('/api/auth', credentials)), 401, 'INVALID_CREDENTIALS');
    expect(
      (await POST(request('/api/auth', { ...credentials, password: change.newPassword }))).status,
    ).toBe(200);
  });

  it('allows only one simultaneous password change and accepts only its replacement password', async () => {
    const created = await setup(request('/api/auth/setup', credentials));
    const headers = { Cookie: cookie(created) };
    const replacements = ['replacement-password-one', 'replacement-password-two'];
    const changes = await Promise.all(
      replacements.map((newPassword) =>
        password(
          request(
            '/api/auth/password',
            { currentPassword: credentials.password, newPassword },
            headers,
          ),
        ),
      ),
    );
    expect(changes.map((response) => response.status).sort()).toEqual([200, 401]);
    const winner = changes.findIndex((response) => response.status === 200);
    expect(
      (
        await protectedRoute(
          request('/api/settings', undefined, { Cookie: cookie(changes[winner]) }),
        )
      ).status,
    ).toBe(200);
    expect((await protectedRoute(request('/api/settings', undefined, headers))).status).toBe(401);
    for (const [index, newPassword] of replacements.entries())
      expect(
        (await POST(request('/api/auth', { ...credentials, password: newPassword }))).status,
      ).toBe(index === winner ? 200 : 401);
  });

  it('binds bearer automation to the first account after setup and password rotation; tokens cannot sign in browsers', async () => {
    const token = persistentSecret('access.token', 32).toString('hex');
    const headers = { Authorization: `Bearer ${token}` };
    expect((await protectedRoute(request('/api/settings', undefined, headers))).status).toBe(409);
    const created = await setup(request('/api/auth/setup', credentials));
    await error(await POST(request('/api/auth', { token })), 400, 'VALIDATION_ERROR');
    await password(
      request(
        '/api/auth/password',
        { currentPassword: credentials.password, newPassword: 'replacement-password' },
        { Cookie: cookie(created) },
      ),
    );
    expect((await protectedRoute(request('/api/settings', undefined, headers))).status).toBe(200);
    expect(persistentSecret('access.token', 32).toString('hex')).toBe(token);
    expect(
      (await protectedRoute(request('/api/settings', undefined, { Authorization: 'Bearer wrong' })))
        .status,
    ).toBe(401);
  });

  it('rejects tampered, expired and legacy token cookies, and marks HTTPS cookies Secure', async () => {
    const created = await setup(
      new Request('https://reader.test/api/auth/setup', {
        method: 'POST',
        headers: { Origin: 'https://reader.test', 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      }),
    );
    expect(created.headers.get('set-cookie')).toContain('; Secure');
    const session = cookie(created);
    for (const invalid of [
      `${session}bad`,
      session.replace('v2.', 'v3.'),
      'bunko_session=9999999999999.legacy-signature',
    ])
      expect(
        (await protectedRoute(request('/api/settings', undefined, { Cookie: invalid }))).status,
      ).toBe(401);
    clock += 7 * 24 * 60 * 60 * 1000;
    expect(
      (await protectedRoute(request('/api/settings', undefined, { Cookie: session }))).status,
    ).toBe(401);
  });

  it('checks origins on setup/login/password/logout before accepting mutations', async () => {
    for (const Origin of ['https://evil.invalid', 'null', 'invalid origin']) {
      await error(
        await setup(request('/api/auth/setup', credentials, { Origin })),
        403,
        'FORBIDDEN',
      );
      await error(await POST(request('/api/auth', credentials, { Origin })), 403, 'FORBIDDEN');
    }
    const created = await setup(request('/api/auth/setup', credentials));
    for (const Origin of ['https://evil.invalid', 'null']) {
      const headers = { Origin, Cookie: cookie(created), 'X-Forwarded-Host': 'evil.invalid' };
      await error(
        await password(
          request(
            '/api/auth/password',
            { currentPassword: credentials.password, newPassword: 'replacement-password' },
            headers,
          ),
        ),
        403,
        'FORBIDDEN',
      );
      await error(
        await DELETE(request('/api/auth', undefined, headers, 'DELETE')),
        403,
        'FORBIDDEN',
      );
    }
    expect(() =>
      authenticate(request('/api/settings', undefined, { Cookie: cookie(created) })),
    ).not.toThrow();
  });
});

it('migrates v3 idempotently, preserves account data and never downgrades a newer version', () => {
  const database = new Database(':memory:');
  database.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('fixture','preserve'); PRAGMA user_version=3;",
  );
  migrateV4(database);
  database
    .prepare('INSERT INTO administrator VALUES(1,?,?,?)')
    .run('Reader', 'versioned-hash', 'epoch');
  migrateV4(database);
  expect(database.pragma('user_version', { simple: true })).toBe(4);
  expect(database.prepare('SELECT value FROM settings').get()).toEqual({ value: 'preserve' });
  expect(database.prepare('SELECT username FROM administrator').get()).toEqual({
    username: 'Reader',
  });
  database.pragma('user_version=5');
  migrateV4(database);
  expect(database.pragma('user_version', { simple: true })).toBe(5);
  database.close();
});
