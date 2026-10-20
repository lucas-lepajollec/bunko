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

it('reconnects continuous snapshots after transport loss but closes finite streams and disposed subscriptions', async () => {
  const instances: FakeStream[] = [];
  class FakeStream {
    static CONNECTING = 0;
    readyState = 0;
    closed = false;
    onerror?: (e: Event) => void;
    handlers = new Map<string, (e: MessageEvent) => void>();
    constructor() {
      instances.push(this);
    }
    addEventListener(event: string, handler: (e: MessageEvent) => void) {
      this.handlers.set(event, handler);
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal('EventSource', FakeStream);
  const { openStream } = await import('@/lib/client/api');
  const snapshot = vi.fn(),
    failure = vi.fn();
  const close = openStream('/api/downloads/stream', { snapshot }, failure, { reconnect: true });
  instances[0].onerror?.(new Event('error'));
  expect(failure).toHaveBeenCalledOnce();
  expect(instances[0].closed).toBe(false);
  instances[0].handlers.get('snapshot')?.(
    new MessageEvent('snapshot', { data: '{"complete":true}' }),
  );
  expect(snapshot).toHaveBeenCalledWith({ complete: true });
  close();
  expect(instances[0].closed).toBe(true);
  openStream('/api/search/stream', {});
  instances[1].onerror?.(new Event('error'));
  expect(instances[1].closed).toBe(true);
});
