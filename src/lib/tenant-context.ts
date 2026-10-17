import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { env } from './env';

export const accountsDir = path.resolve(/* turbopackIgnore: true */ env('DATA_DIR') ?? './data');
export interface Tenant {
  id: number;
}
const runtime = globalThis as typeof globalThis & {
  __bunkoTenantContext?: AsyncLocalStorage<Tenant>;
};
export const tenantContext = (runtime.__bunkoTenantContext ??= new AsyncLocalStorage<Tenant>());
export function tenantId(): number {
  const tenant = tenantContext.getStore();
  if (!tenant || !Number.isSafeInteger(tenant.id) || tenant.id < 1)
    throw new Error('Tenant context is required');
  return tenant.id;
}
export function tenantPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid tenant ID');
  return path.join(accountsDir, 'users', String(id));
}
export function inTenant<T>(id: number, run: () => T): T {
  return tenantContext.run({ id }, run);
}
/** Module-local values are partitioned even when Next bundles a module more than once. */
export function tenantState<T>(create: () => T): () => T {
  const values = new Map<number, T>();
  return () => {
    const id = tenantId();
    if (!values.has(id)) values.set(id, create());
    return values.get(id)!;
  };
}
