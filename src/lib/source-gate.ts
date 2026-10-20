import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { getSettings } from './settings';
import { tenantPath, tenantId } from './tenant-context';
import { AppError } from './errors';

const runtime = globalThis as typeof globalThis & {
  __bunkoSourceBackground?: AsyncLocalStorage<boolean>;
  __bunkoSourceBudgets?: Map<string, ReturnType<typeof createBudget>>;
};
const background = (runtime.__bunkoSourceBackground ??= new AsyncLocalStorage<boolean>());
export const withBackgroundSources = <T>(run: () => T): T => background.run(true, run);
export const isBackgroundSourceWork = () => background.getStore() === true;

type Waiter = { tenant: string; background: boolean; start: () => void };
/** Two of six slots are reserved for interactive work; background lanes rotate by tenant. */
function createBudget() {
  let active = 0,
    activeBackground = 0;
  const queue: Waiter[] = [];
  const drain = () => {
    while (active < 6) {
      let index = queue.findIndex((w) => !w.background);
      if (index < 0 && activeBackground < 4) {
        index = queue.findIndex((w) => w.background);
      }
      if (index < 0) break;
      const [waiter] = queue.splice(index, 1);
      active++;
      if (waiter.background) {
        activeBackground++;
        const sameLane = queue.filter((w) => w.background && w.tenant === waiter.tenant);
        for (const pending of sameLane) queue.splice(queue.indexOf(pending), 1);
        queue.push(...sameLane);
      }
      waiter.start();
    }
  };
  return async <T>(
    job: () => Promise<T>,
    signal: AbortSignal | undefined,
    tenant: string,
    bg: boolean,
  ) => {
    signal?.throwIfAborted();
    if (queue.length >= 256) throw new AppError('UPSTREAM_TIMEOUT', 'Source queue is full', 503);
    // Bound queue residence independently of the provider's own network timeout.
    const waiting = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(waiting.reason);
      };
      const waiter: Waiter = {
        tenant,
        background: bg,
        start: () => {
          waiting.removeEventListener('abort', abort);
          resolve();
        },
      };
      waiting.addEventListener('abort', abort, { once: true });
      queue.push(waiter);
      drain();
    });
    try {
      signal?.throwIfAborted();
      return await job();
    } finally {
      active--;
      if (bg) activeBackground--;
      drain();
    }
  };
}
export function sourceCall<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // Credentials do not partition a server's capacity. No private results enter this registry.
  const url = new URL(getSettings().suwayomiUrl);
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  const key = createHash('sha256').update(url.toString().replace(/\/+$/, '')).digest('hex');
  const budgets = (runtime.__bunkoSourceBudgets ??= new Map());
  let budget = budgets.get(key);
  if (!budget) {
    budget = createBudget();
    budgets.set(key, budget);
  }
  return budget(job, signal, tenantPath(tenantId()), isBackgroundSourceWork());
}
