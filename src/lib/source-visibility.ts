import type { UnifiedMedia } from '@/types/shared';
import { statement } from './db';
import { getSettings } from './settings';
import { adultClassifier } from './adult';
import { emptyMedia, fromAniList, normalizeTitle, type AniMedia } from './media';
import { decodeMetadata } from './metadata-cache';

/** Local evidence only. Unknown source works remain visible, independent of extension flags. */
export function sourceResultVisibility() {
  if (getSettings().adultContent) return () => true;
  const classify = adultClassifier();
  const byId = new Map<string, UnifiedMedia>();
  const byTitle = new Map<string, UnifiedMedia | null>();
  const add = (m: UnifiedMedia) => {
    if (!m?.id || !Array.isArray(m.altTitles) || m.type !== 'MANGA') return;
    byId.set(m.id, m);
    for (const source of m.sources ?? []) byId.set(`suwayomi:${source.suwayomiMangaId}`, m);
    for (const title of [m.title, ...m.altTitles]) {
      const key = normalizeTitle(title);
      const old = byTitle.get(key);
      if (old === undefined || old?.id === m.id) byTitle.set(key, m);
      else byTitle.set(key, null); // Ambiguous names cannot establish identity.
    }
  };
  for (const row of statement('SELECT media_json,sources_json FROM tracked_media').all() as {
    media_json: string;
    sources_json: string;
  }[]) {
    const m = JSON.parse(row.media_json) as UnifiedMedia;
    add({ ...m, sources: [...m.sources, ...JSON.parse(row.sources_json)] });
  }
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.id === 'string' && Array.isArray(item.providers)) add(value as UnifiedMedia);
    else if (typeof item.id === 'number' && item.title && typeof item.title === 'object')
      add(fromAniList(value as AniMedia));
    for (const child of Object.values(item)) if (child && typeof child === 'object') visit(child);
  };
  for (const row of statement(
    "SELECT key,payload FROM metadata_cache WHERE key LIKE 'detail:%' OR key LIKE 'discover:%' OR key LIKE 'search:%'",
  ).all() as { key: string; payload: string }[])
    visit(decodeMetadata(row.key, row.payload)?.value);
  return (id: number, title: string) => {
    const local = emptyMedia(`suwayomi:${id}`, title, 'MANGA');
    const mapped = byId.get(local.id) ?? byTitle.get(normalizeTitle(title));
    // Explicit source overrides take precedence over inferred title associations.
    return !classify(
      mapped
        ? {
            ...mapped,
            sources: [
              ...mapped.sources,
              {
                sourceId: '',
                sourceName: '',
                suwayomiMangaId: id,
                mangaUrl: '',
                thumbnailUrl: null,
                lang: '',
              },
            ],
          }
        : local,
    );
  };
}
