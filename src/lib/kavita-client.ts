import { createHash } from 'node:crypto';
import { boundedBuffer } from './chapter-pages';
import { cached } from './metadata-cache';
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { AppError } from './errors';
export async function kavitaHeaders(
  signal?: AbortSignal,
  progressApiKey?: string,
): Promise<Record<string, string>> {
  const s = {
    ...getSettings(),
    ...(progressApiKey === undefined ? {} : { kavitaApiKey: progressApiKey }),
  };
  if (!s.kavitaUrl || !s.kavitaApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Kavita is not configured', 409);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.kavitaAuthMode === 'jwt') {
    const url = new URL(endpoint(s.kavitaUrl, '/api/Plugin/authenticate'));
    url.searchParams.set('apiKey', s.kavitaApiKey);
    url.searchParams.set('pluginName', 'Bunko');
    const auth = await requestJson<{ token: string }>(url, { method: 'POST', signal });
    if (!auth.token) throw new AppError('KAVITA_AUTH_ERROR', 'Kavita authentication failed', 502);
    headers.Authorization = `Bearer ${auth.token}`;
  } else headers['x-api-key'] = s.kavitaApiKey;
  return headers;
}
export async function kavitaJson<T>(suffix: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(
    endpoint(getSettings().kavitaUrl, suffix),
    { ...init, headers: await kavitaHeaders(init.signal ?? undefined) },
    20_000,
  );
}

/** Stable Kavita requires this query key; develop ignores it. Never return this URL to clients. */
export function kavitaCoverEndpoint(seriesId: string | number) {
  const settings = getSettings();
  const url = new URL(endpoint(settings.kavitaUrl, '/api/Image/series-cover'));
  url.searchParams.set('seriesId', String(seriesId));
  url.searchParams.set('apiKey', settings.kavitaApiKey);
  return url.toString();
}

/** Read roles only from a token returned directly by the configured Kavita server. */
export async function kavitaAdmin(signal?: AbortSignal): Promise<boolean | null> {
  const s = getSettings();
  if (!s.kavitaUrl || !s.kavitaApiKey) return null;
  const identity = createHash('sha256')
    .update(JSON.stringify([s.kavitaUrl, s.kavitaApiKey]))
    .digest('hex');
  return cached<boolean | null>(`kavita_admin:${identity}`, 600_000, async () => {
    try {
      const url = new URL(endpoint(s.kavitaUrl, '/api/Plugin/authenticate'));
      url.searchParams.set('apiKey', s.kavitaApiKey);
      url.searchParams.set('pluginName', 'Bunko');
      const auth = await requestJson<{ token?: string }>(url, { method: 'POST', signal }, 4000);
      if (!auth.token || auth.token.length > 32_768) return null;
      const claims = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString());
      const roles =
        claims.role ?? claims['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];
      if (typeof roles !== 'string' && !Array.isArray(roles)) return null;
      return (Array.isArray(roles) ? roles : [roles]).some((role) => role === 'Admin');
    } catch {
      return null;
    }
  });
}

/** scan-folder is anonymous and authenticates exclusively from ScanFolderDto.ApiKey. */
export async function scanKavitaFolder(folderPath: string, signal?: AbortSignal) {
  const s = getSettings();
  if (!s.kavitaUrl || !s.kavitaApiKey)
    throw new AppError('KAVITA_SCAN_ERROR', 'Kavita scan is not configured', 409);
  try {
    const response = await fetch(endpoint(s.kavitaUrl, '/api/Library/scan-folder'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: s.kavitaApiKey, folderPath }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
      redirect: 'error',
    });
    let nonAdmin = response.status === 403;
    if (response.status === 400) {
      // Inspect only a bounded body to recognize Kavita's fixed denial; never retain it.
      const body = await boundedBuffer(
        new Response(response.body, { headers: response.headers }),
        4096,
      ).catch(() => Buffer.alloc(0));
      nonAdmin = body.toString().includes('API key must belong to an admin');
    } else await response.body?.cancel();
    if (nonAdmin)
      throw new AppError('KAVITA_NOT_ADMIN', 'Kavita requires an administrator key', 502);
    if (!response.ok) throw new Error('Scan rejected');
  } catch (error) {
    if (error instanceof AppError && error.code === 'KAVITA_NOT_ADMIN') throw error;
    throw new AppError('KAVITA_SCAN_ERROR', 'Kavita scan failed', 502);
  }
}
