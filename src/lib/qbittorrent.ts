import { AppError } from './errors';
import { endpoint } from './http';
import { getSettings } from './settings';
import { tenantState } from './tenant-context';

/**
 * qBittorrent Web API (v2): only reads the torrent list, to show the progress of what Bunko sent
 * (through Prowlarr, Sonarr or Radarr). The session cookie stays in memory, per account.
 */
const session = tenantState(() => ({ sid: null as string | null, base: '' }));

export const qbittorrentConfigured = () => Boolean(getSettings().qbittorrentUrl);

async function call(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const s = getSettings();
  if (!s.qbittorrentUrl)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'qBittorrent is not configured', 409);
  const base = s.qbittorrentUrl.replace(/\/+$/, '');
  const state = session();
  if (state.base !== base) Object.assign(state, { sid: null, base });
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(init.signal ? [init.signal] : []),
  ]);
  try {
    return await fetch(endpoint(base, path), {
      ...init,
      signal,
      cache: 'no-store',
      redirect: 'error',
      headers: {
        // qBittorrent refuses API calls whose Referer/Origin is another host (CSRF protection).
        Referer: base,
        Origin: new URL(base).origin,
        // qBittorrent ≥ 5.2: an API key replaces the login session.
        ...(s.qbittorrentApiKey
          ? { Authorization: `Bearer ${s.qbittorrentApiKey}` }
          : state.sid
            ? { Cookie: `SID=${state.sid}` }
            : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new AppError(
      signal.aborted ? 'QBITTORRENT_TIMEOUT' : 'QBITTORRENT_UNREACHABLE',
      'qBittorrent could not be reached',
      502,
    );
  }
}

async function login() {
  const s = getSettings();
  const response = await call('/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: s.qbittorrentUsername,
      password: s.qbittorrentPassword,
    }).toString(),
  });
  const text = await response.text();
  const sid = /SID=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? null;
  // "Ok." with a cookie; no cookie but "Ok." when the client trusts Bunko's address (no login).
  if (!response.ok || !/^Ok\./.test(text.trim()))
    throw new AppError('QBITTORRENT_UNAUTHORIZED', 'qBittorrent rejected the login', 502);
  session().sid = sid;
}

/** One authenticated call, logging in again once when the session expired. */
async function api(path: string): Promise<Response> {
  let response = await call(path);
  // With an API key there is no session to renew: a refusal means the key is wrong.
  if ((response.status === 403 || response.status === 401) && !getSettings().qbittorrentApiKey) {
    await response.body?.cancel();
    await login();
    response = await call(path);
  }
  if (response.status === 403 || response.status === 401) {
    await response.body?.cancel();
    throw new AppError('QBITTORRENT_UNAUTHORIZED', 'qBittorrent rejected the login', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('QBITTORRENT_ERROR', `qBittorrent returned HTTP ${response.status}`, 502);
  }
  return response;
}

export async function qbittorrentVersion(): Promise<string> {
  return (await (await api('/api/v2/app/version')).text()).trim();
}

export interface Torrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  eta: number;
  state: string;
  category?: string;
}
/** The most recent torrents (newest first). */
export async function torrents(limit = 300): Promise<Torrent[]> {
  const response = await api(
    `/api/v2/torrents/info?filter=all&sort=added_on&reverse=true&limit=${limit}`,
  );
  return (await response.json()) as Torrent[];
}
