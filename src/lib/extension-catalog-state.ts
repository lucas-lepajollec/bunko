import { tenantState } from './tenant-context';

/**
 * Which configured video extensions advertise a catalog of the generic `extvideo` type. Kept in
 * memory only: it names runtime catalogs of the account's own extensions, never project data.
 */
const state = tenantState(() => ({ addons: new Set<string>() }));

export function noteExtensionCatalog(addonId: string, available: boolean) {
  if (available) state().addons.add(addonId);
  else state().addons.delete(addonId);
}
export function pruneExtensionCatalogs(configured: string[]) {
  const keep = new Set(configured);
  for (const id of state().addons) if (!keep.has(id)) state().addons.delete(id);
}
export function resetExtensionCatalogs() {
  state().addons.clear();
}
export function extensionCatalogAvailable() {
  return state().addons.size > 0;
}
