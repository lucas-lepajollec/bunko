import { afterEach, expect, it, vi } from 'vitest';
import { createCoverLoader } from '@/lib/client/cover-loader';

afterEach(() => vi.unstubAllGlobals());
const image = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });

it('leaves HTTP connections free while slow covers fill a large library queue', async () => {
  const finish: (() => void)[] = [];
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        finish.push(() => resolve(image()));
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const load = createCoverLoader(2);
  const controllers = Array.from({ length: 40 }, () => new AbortController());
  const pending = controllers.map((c, i) => load(`/api/covers/${i + 1}`, c.signal));
  const done = Promise.allSettled(pending);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  // Leave the screen: active transfers and every obsolete waiter are cancelled.
  for (const c of controllers) c.abort();
  expect((await done).every((r) => r.status === 'rejected')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const next = load('/api/covers/100', new AbortController().signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  finish.at(-1)!();
  expect((await next).size).toBe(3);
});

it('hands over a completed slot and retains authenticated browser caching', async () => {
  const finish: (() => void)[] = [];
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    expect(init?.referrerPolicy).toBe('no-referrer');
    expect(init?.cache).toBeUndefined();
    return new Promise<Response>((resolve) => finish.push(() => resolve(image())));
  });
  vi.stubGlobal('fetch', fetcher);
  const load = createCoverLoader(1);
  const a = load('/api/covers/1', new AbortController().signal);
  const b = load('/api/covers/2', new AbortController().signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  finish[0]();
  expect((await a).type).toBe('image/png');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  finish[1]();
  await b;
});

it('rejects nonimages, oversized and empty payloads, releasing capacity after each failure', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'fixture' }))
    .mockResolvedValueOnce(
      new Response('x', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(16 * 1024 * 1024) },
      }),
    )
    .mockResolvedValueOnce(new Response('', { headers: { 'Content-Type': 'image/png' } }))
    .mockResolvedValueOnce(image());
  vi.stubGlobal('fetch', fetcher);
  const load = createCoverLoader(1);
  for (let i = 0; i < 3; i++)
    await expect(load(`/api/covers/${i}`, new AbortController().signal)).rejects.toThrow();
  expect((await load('/api/covers/4', new AbortController().signal)).size).toBe(3);
});

it('does not start a request that was cancelled before entry', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  controller.abort();
  await expect(createCoverLoader()('/api/covers/1', controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
