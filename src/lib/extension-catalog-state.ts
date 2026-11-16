import type { ExtensionSection } from '@/types/shared';
import { tenantState } from './tenant-context';

/**
 * The sections each configured video extension declares through its `extvideo` catalogs. Kept in
 * memory only: names and ids are the extensions' own runtime data, never project data.
 */
const state = tenantState(() => ({ addons: new Map<string, ExtensionSection[]>() }));

export function noteExtensionSections(addonId: string, sections: ExtensionSection[]) {
  if (sections.length) state().addons.set(addonId, sections);
  else state().addons.delete(addonId);
}
export function pruneExtensionSections(configured: string[]) {
  const keep = new Set(configured);
  for (const id of state().addons.keys()) if (!keep.has(id)) state().addons.delete(id);
}
export function resetExtensionSections() {
  state().addons.clear();
}
/**
 * Sections the 18+ mode shows: adult ones only in the full 18+ mode, the others everywhere else.
 * Two extensions declaring the same id share one section (the first name wins).
 */
export function visibleExtensionSections(adultOnly: boolean): ExtensionSection[] {
  const out = new Map<string, ExtensionSection>();
  for (const id of [...state().addons.keys()].sort())
    for (const section of state().addons.get(id)!)
      if (section.adult === adultOnly && !out.has(section.id)) out.set(section.id, section);
  return [...out.values()];
}
