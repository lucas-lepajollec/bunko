import type { ChapterRelease, TrackedMedia } from '@/types/shared';
import { listTracked, statement } from './db';
import { visibleTracked } from './adult';
import { publicFeed } from './public-feed-http';
import { parseXml, nodes, values } from './feed-xml';
import { normalizeTitle } from './media';
import { storedMetadata, decodeMetadata } from './metadata-cache';
/** Only the public fiction RSS endpoint is fetched. No fiction pages/search HTML/chapter scraping. */
export function royalRoadId(value: string): string | null {
  const direct = /^royalroad:(\d+)$/.exec(value);
  if (direct) return direct[1];
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^(?:www\.)?royalroad\.com$/i.test(url.hostname)) return null;
    return /^\/fiction\/(?:syndication\/)?(\d+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
export function trackedRoyalRoadId(t: TrackedMedia): string | null {
  for (const url of [
    t.media.id,
    t.media.webUrl,
    ...t.media.sources.map((s) => s.mangaUrl),
    (t.media as typeof t.media & { royalRoadUrl?: string }).royalRoadUrl,
  ]) {
    const id = url ? royalRoadId(url) : null;
    if (id) return id;
  }
  for (const source of t.sources) {
    for (const r of statement(
      'SELECT manga_url FROM catalog_fts WHERE source_id=? AND source_manga_id=?',
    ).all(source.sourceId, String(source.suwayomiMangaId)) as { manga_url: string }[]) {
      const id = royalRoadId(r.manga_url);
      if (id) return id;
    }
  }
  const stored = statement('SELECT media_json FROM tracked_media WHERE id=?').get(t.id) as
    { media_json: string } | undefined;
  const extra = stored ? JSON.parse(stored.media_json).royalRoadUrl : null;
  if (typeof extra === 'string' && royalRoadId(extra)) return royalRoadId(extra);
  // Reuse exact public catalog matches already in the tenant's cache, without a network search.
  const ids = new Set<string>();
  for (const row of statement(
    "SELECT key,payload FROM metadata_cache WHERE key LIKE 'detail:%' OR key LIKE 'search:%'",
  ).all() as { key: string; payload: string }[]) {
    const raw = decodeMetadata(row.key, row.payload)?.value;
    const visit = (value: unknown, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return;
      const v = value as Record<string, unknown>;
      if (
        typeof v.title === 'string' &&
        normalizeTitle(v.title) === normalizeTitle(t.media.title) &&
        (typeof v.webUrl === 'string' || typeof v.royalRoadUrl === 'string')
      ) {
        const id = royalRoadId(String(v.royalRoadUrl ?? v.webUrl));
        if (id) ids.add(id);
      }
      for (const c of Object.values(v)) if (c && typeof c === 'object') visit(c, depth + 1);
    };
    visit(raw);
  }
  return ids.size === 1 ? [...ids][0] : null;
}
export function royalRoadReleases(xml: string, t: TrackedMedia, id: string): ChapterRelease[] {
  const tree = parseXml(xml);
  if (!nodes(tree, 'channel').length) throw new Error('Invalid RSS');
  return nodes(tree, 'item')
    .slice(0, 100)
    .flatMap((item) => {
      const title = values(item, 'title')[0] ?? '';
      const link = values(item, 'link')[0] ?? values(item, 'guid')[0] ?? '';
      let chapterId: string | undefined;
      try {
        const url = new URL(link);
        if (!/^(?:www\.)?royalroad\.com$/i.test(url.hostname) || url.protocol !== 'https:')
          return [];
        chapterId = /\/fiction\/chapter\/(\d+)|\/chapter\/(\d+)/
          .exec(url.pathname)
          ?.slice(1)
          .find(Boolean);
      } catch {
        return [];
      }
      if (!chapterId) return [];
      const date = Date.parse(values(item, 'pubDate')[0] ?? '');
      if (!Number.isFinite(date)) return [];
      const number = title.match(
        /\b(?:chapter|ch\.?|episode)\s*#?\s*(\d+(?:\.\d+)?)|^\s*(\d+(?:\.\d+)?)(?:\s*[-:.]|\s*$)/i,
      );
      const chapter = number ? Number(number[1] ?? number[2]) : null;
      return [
        {
          id: `royalroad:${id}:${chapterId}`,
          media: t.media,
          chapter,
          volume: null,
          label: chapter === null ? title : `c.${chapter}`,
          releasedAt: new Date(date).toISOString(),
          hasTime: true,
          unit: 'chapter' as const,
          provider: 'royalroad' as const,
          trackedId: t.id,
          group: 'Royal Road',
        },
      ];
    });
}
export async function refreshRoyalRoad(onBatch: (items: ChapterRelease[]) => void): Promise<void> {
  const candidates = visibleTracked(listTracked())
    .filter((t) => t.type === 'NOVEL')
    .map((t) => ({ t, id: trackedRoyalRoadId(t) }))
    .filter((r) => r.id);
  // Oldest poll first; bounded rotation prevents a large library starving later works.
  candidates.sort(
    (a, b) =>
      (storedMetadata(`rr-poll:${a.t.id}`)?.at ?? 0) -
      (storedMetadata(`rr-poll:${b.t.id}`)?.at ?? 0),
  );
  const { saveMetadata } = await import('./metadata-cache');
  for (const { t, id } of candidates.slice(0, 5)) {
    saveMetadata(`rr-poll:${t.id}`, Date.now());
    try {
      const xml = await publicFeed(
        'royalroad',
        `https://www.royalroad.com/fiction/syndication/${id}`,
        30 * 60_000,
        (text) => {
          parseXml(text);
          return text;
        },
      );
      onBatch(royalRoadReleases(xml, t, id!));
    } catch {
      /* A failed feed never hides other followed works. */
    }
  }
}
