import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('navigator', { languages: ['en-US'] });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('sends the explicit interface choice in fetch and SSE even when the browser prefers English', async () => {
  const { getUiLanguage, setUiLanguage } = await import('@/i18n/language');
  const { api, openStream } = await import('@/lib/client/api');
  expect(getUiLanguage()).toBe('en');
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/sources');
    expect(init?.credentials).toBe('same-origin');
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetcher);
  const streams: { url: string; closed: boolean }[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      closed = false;
      constructor(public url: string) {
        streams.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    },
  );
  setUiLanguage('fr');
  await api('/api/sources', { headers: new Headers({ 'X-Fixture': 'kept' }) });
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(headers.get('accept-language')).toBe('fr');
  expect(headers.get('x-fixture')).toBe('kept');
  const close = openStream('/api/search/stream?q=One+Piece', {});
  const url = new URL(streams[0].url, 'http://fixture.invalid');
  expect(url.searchParams.get('q')).toBe('One Piece');
  expect(url.searchParams.get('uiLanguage')).toBe('fr');
  close();
  expect(streams[0].closed).toBe(true);
  setUiLanguage('it');
  await api('/api/sources');
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('accept-language')).toBe('it');
  openStream('/api/media/sources?id=anilist%3A1', {})();
  expect(new URL(streams[1].url, 'http://fixture.invalid').searchParams.get('uiLanguage')).toBe(
    'it',
  );
});

it('keeps a manual interface choice when browser storage is blocked and notifies subscribers', async () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  });
  const { getUiLanguage, setUiLanguage, subscribeLanguage } = await import('@/i18n/language');
  const listener = vi.fn();
  const unsubscribe = subscribeLanguage(listener);
  setUiLanguage('de');
  expect(getUiLanguage()).toBe('de');
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  setUiLanguage('es');
  expect(listener).toHaveBeenCalledTimes(1);
});
