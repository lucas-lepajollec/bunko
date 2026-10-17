import { accountsDir } from './tenant-context';
import { dataDir } from './db';
import { env } from './env';
type State = { listeners: Set<() => void> };
const scope = globalThis as typeof globalThis & { __bunkoWorkerEvents?: Map<string, State> };
const states = (scope.__bunkoWorkerEvents ??= new Map());
function state() {
  let value = states.get(dataDir());
  if (!value) {
    value = { listeners: new Set() };
    states.set(dataDir(), value);
  }
  return value;
}
export function wakeWorker() {
  for (const listener of state().listeners) listener();
  for (const listener of schedulerListeners()) listener();
}
export function onWorkerWake(listener: () => void) {
  const listeners = state().listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function workerIdleMs() {
  const value = Number(env('WORKER_IDLE_MS') ?? 30_000);
  return Number.isFinite(value) ? Math.max(1000, Math.min(300_000, value)) : 30_000;
}
export function waitForWorker(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const off = onWorkerWake(done);
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function schedulerListeners() {
  const key = `scheduler:${accountsDir}`;
  let value = states.get(key);
  if (!value) states.set(key, (value = { listeners: new Set() }));
  return value.listeners;
}
export function onAllTenantsWake(listener: () => void) {
  schedulerListeners().add(listener);
  return () => schedulerListeners().delete(listener);
}
