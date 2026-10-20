/** Shared FIFO gate: waiting does not consume the upstream request deadline. */
export function concurrencyGate(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
        reject(signal?.reason);
      };
      const start = () => {
        signal?.removeEventListener('abort', abort);
        active++;
        resolve();
      };
      if (active < limit) start();
      else {
        queue.push(start);
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      signal?.throwIfAborted();
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
export async function eachConcurrent<T>(
  items: T[],
  limit: number,
  job: (item: T) => Promise<void>,
  signal?: AbortSignal,
) {
  let next = 0;
  let failure: unknown;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !signal?.aborted && !failure) {
        try {
          await job(items[next++]);
        } catch (e) {
          failure = e;
          throw e;
        }
      }
    }),
  );
  const rejected = settled.find((r) => r.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  signal?.throwIfAborted();
}
/** A process-wide gate also covers independently loaded Next route bundles. */
export function sharedConcurrencyGate(
  name: string,
  limit: number,
): ReturnType<typeof concurrencyGate> {
  const scope = globalThis as typeof globalThis & {
    __bunkoGates?: Map<string, ReturnType<typeof concurrencyGate>>;
  };
  const registry = (scope.__bunkoGates ??= new Map<string, ReturnType<typeof concurrencyGate>>());
  let gate = registry.get(name);
  if (!gate) {
    gate = concurrencyGate(limit);
    registry.set(name, gate);
  }
  return gate;
}

/** Stop waiting without cancelling a coalesced load that another caller may still need. */
export function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
