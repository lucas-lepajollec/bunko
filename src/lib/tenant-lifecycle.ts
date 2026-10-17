import { accountsDir, tenantId } from './tenant-context';
const runtime = globalThis as typeof globalThis & {
  __bunkoTenantAbort?: Map<string, AbortController>;
};
const controllers = (runtime.__bunkoTenantAbort ??= new Map());
function key(id: number) {
  return `${accountsDir}:${id}`;
}
export function tenantSignal() {
  const scope = key(tenantId());
  let controller = controllers.get(scope);
  if (!controller) controllers.set(scope, (controller = new AbortController()));
  return controller.signal;
}
/** Revocation is shared across Next route bundles and immediately stops active transfers. */
export function revokeTenant(id: number) {
  const scope = key(id);
  let controller = controllers.get(scope);
  if (!controller) controllers.set(scope, (controller = new AbortController()));
  controller.abort();
}
