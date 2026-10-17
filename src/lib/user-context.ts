import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '@/types/shared';

export interface Identity {
  id: number;
  username: string;
  role: UserRole;
}
// Next bundles routes separately; the request context must be shared across those bundles.
const runtime = globalThis as typeof globalThis & {
  __bunkoUserContext?: AsyncLocalStorage<Identity | undefined>;
};
export const userContext = (runtime.__bunkoUserContext ??= new AsyncLocalStorage<
  Identity | undefined
>());
export function currentUser() {
  return userContext.getStore();
}
export function asServer<T>(run: () => T): T {
  return userContext.run(undefined, run);
}
