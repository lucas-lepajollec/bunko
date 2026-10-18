import type { DiscoverPage, UnifiedMedia } from '@/types/shared';
import { storedMetadata, saveMetadata } from './metadata-cache';
import { dataDir } from './db';
import { deduplicate } from './search-engine';
import { AppError } from './errors';
import { tenantSignal } from './tenant-lifecycle';
type State = {
  pages: Record<string, DiscoverPage>;
  failures: string[];
  pending: boolean;
  at: number;
};
const runtime = globalThis as typeof globalThis & {
  __bunkoDiscoverLoads?: Map<string, Promise<void>>;
};
const loads = (runtime.__bunkoDiscoverLoads ??= new Map<string, Promise<void>>());

/** Provider pages retain every item; round-robin order does not invent a common popularity score. */
export async function discoverAll(
  key: string,
  page: number,
  providers: Record<string, () => Promise<DiscoverPage>>,
  nonfatalWarningPages = false,
): Promise<DiscoverPage> {
  const hit = storedMetadata<State>(key)?.value;
  const degraded =
    hit && (hit.failures.length || Object.values(hit.pages).some((p) => p.warnings?.length));
  const fresh = hit && Date.now() - hit.at < (degraded ? 30_000 : 10 * 60_000);
  const pendingKey = `${dataDir()}:${key}`;
  const response = (state: State): DiscoverPage => {
    if (
      !state.pending &&
      !Object.entries(state.pages).some(
        ([name, p]) =>
          p.items.length ||
          (!state.failures.includes(name) && (nonfatalWarningPages || !p.warnings?.length)),
      )
    )
      throw new AppError('METADATA_UNAVAILABLE', 'Catalog providers are unavailable', 502);
    const lanes = Object.keys(providers).flatMap((k) =>
      state.pages[k] ? [state.pages[k].items] : [],
    );
    const items: UnifiedMedia[] = [];
    for (let i = 0; i < Math.max(0, ...lanes.map((l) => l.length)); i++)
      for (const lane of lanes) if (lane[i]) items.push(lane[i]);
    return {
      items: deduplicate(items),
      page,
      hasNextPage: Object.values(state.pages).some((p) => p.hasNextPage),
      pending: state.pending,
      ...(state.failures.length || Object.values(state.pages).some((p) => p.warnings?.length)
        ? {
            warnings: [
              ...state.failures.map((provider) => ({
                provider,
                code: 'METADATA_UNAVAILABLE' as const,
              })),
              ...Object.values(state.pages).flatMap((p) => p.warnings ?? []),
            ],
          }
        : {}),
    };
  };
  if (fresh && !hit.pending) return response(hit);
  let first!: () => void;
  const ready = new Promise<void>((resolve) => {
    first = resolve;
  });
  if (!loads.has(pendingKey)) {
    const state: State = {
      pages: { ...hit?.pages },
      failures: fresh ? [...hit.failures] : [],
      pending: true,
      at: Date.now(),
    };
    const selected = Object.entries(providers).filter(
      ([name]) =>
        !fresh ||
        (!state.pages[name] && !state.failures.includes(name)) ||
        state.pages[name]?.pending,
    );
    const publish = () => {
      if (!tenantSignal().aborted) saveMetadata(key, state);
    };
    publish();
    const job = Promise.all(
      selected.map(async ([name, load]) => {
        try {
          state.pages[name] = await load();
          state.failures = state.failures.filter((n) => n !== name);
          publish();
          if (state.pages[name].items.length || state.pages[name].pending) first();
        } catch {
          state.failures.push(name);
          if (state.pages[name]) state.pages[name] = { ...state.pages[name], pending: false };
        }
      }),
    )
      .then(() => {
        state.pending = Object.values(state.pages).some((p) => p.pending);
        publish();
      })
      .catch(() => {
        /* Revoked tenant: do not publish another result. */
      })
      .finally(() => {
        loads.delete(pendingKey);
        first();
      });
    loads.set(pendingKey, job);
  } else first();
  if (!hit) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 300);
      }),
    ]);
    clearTimeout(timer);
  }
  return response(
    storedMetadata<State>(key)?.value ?? { pages: {}, failures: [], pending: true, at: Date.now() },
  );
}
