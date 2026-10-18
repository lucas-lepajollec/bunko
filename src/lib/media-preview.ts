import type { MediaDetail, UnifiedMedia } from '@/types/shared';
import { tenantState } from './tenant-context';
import { sourceServerKey } from './source-server';

// Already displayed catalog cards can open immediately while their complete sheet loads.
// Private, bounded, process-local: this never becomes an authoritative provider identity.
const previews = tenantState(() => new Map<string, UnifiedMedia>());
const key = (id: string) => (id.startsWith('suwayomi:') ? `${sourceServerKey()}:${id}` : id);
export function rememberMediaPreview(media: UnifiedMedia) {
  const value = { ...media } as UnifiedMedia & Partial<MediaDetail>;
  delete value.tags;
  delete value.relations;
  delete value.recommendations;
  delete value.pending;
  delete value.partial;
  value.synopsis = value.synopsis?.slice(0, 16_000) ?? null;
  const entries = previews();
  entries.delete(key(media.id));
  entries.set(key(media.id), structuredClone(value));
  if (entries.size > 256) entries.delete(entries.keys().next().value!);
}
export function mediaPreview(id: string) {
  const value = previews().get(key(id));
  return value ? structuredClone(value) : undefined;
}
