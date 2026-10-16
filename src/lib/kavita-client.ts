import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { AppError } from './errors';
export async function kavitaHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
  const s = getSettings();
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
