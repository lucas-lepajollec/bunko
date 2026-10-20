import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@/lib/client/api';
import { waitForSignal } from '@/lib/concurrency';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('ends an obsolete wait while another consumer can still use the shared result', async () => {
  let finish!: (value: number) => void;
  const shared = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const controller = new AbortController();
  const pending = waitForSignal(shared, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  finish(42);
  expect(await shared).toBe(42);
});

it('ends a stuck browser API request with an error instead of an endless skeleton', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  vi.stubGlobal(
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
  );
  const pending = api('/api/discover?kind=manga');
  deadline.abort(new DOMException('Fixture deadline', 'TimeoutError'));
  await expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
});

it('also bounds a JSON body that stalls after headers', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  vi.stubGlobal(
    'fetch',
    async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), {
              once: true,
            });
          },
        }),
      ),
  );
  const pending = api('/api/discover?kind=manga');
  await Promise.resolve();
  deadline.abort(new DOMException('Fixture deadline', 'TimeoutError'));
  await expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
});

it('keeps a longer bounded wait for explicit mutations such as extension installation', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  vi.stubGlobal('fetch', async () => Response.json({ ok: true }));
  await api('/api/settings', { method: 'PATCH', body: '{}' });
  expect(timeout).toHaveBeenCalledWith(120_000);
});
