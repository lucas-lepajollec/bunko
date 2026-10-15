import type { MediaDetail, Source, SourceCandidate } from '@/types/shared';
import { normalizeTitle } from './media';
import { searchSource } from './suwayomi';
function tokens(value: string) {
  return new Set(
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}
/** Similarity between a source title and the media's known titles, 0..1. */
export function titleScore(candidate: string, titles: string[]) {
  const n = normalizeTitle(candidate);
  if (!n) return 0;
  let best = 0;
  for (const title of titles) {
    const t = normalizeTitle(title);
    if (!t) continue;
    if (t === n) return 1;
    if ((t.includes(n) || n.includes(t)) && Math.min(t.length, n.length) >= 4)
      best = Math.max(
        best,
        0.6 + 0.3 * (Math.min(t.length, n.length) / Math.max(t.length, n.length)),
      );
    const a = tokens(candidate);
    const b = tokens(title);
    const shared = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    if (union) best = Math.max(best, (shared / union) * 0.85);
  }
  return Math.round(best * 100) / 100;
}
/** Up to three distinct queries, most likely to be indexed by French sources first. */
export function searchQueries(media: Pick<MediaDetail, 'title' | 'altTitles'>) {
  const latin = [media.title, ...media.altTitles].filter((t) =>
    /^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(t),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of latin) {
    const key = normalizeTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(
      title
        .replace(/[:!?]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (out.length === 3) break;
  }
  return out;
}
/** Search one source with successive queries until a confident match appears. */
export async function matchOnSource(
  source: Source,
  media: Pick<MediaDetail, 'title' | 'altTitles'>,
  signal?: AbortSignal,
): Promise<SourceCandidate[]> {
  const titles = [media.title, ...media.altTitles];
  const found = new Map<number, SourceCandidate>();
  for (const query of searchQueries(media)) {
    const result = await searchSource(source, query, signal, 1, 'SEARCH', 8000);
    result.results.forEach((hit, i) => {
      const score = titleScore(result.titles[i], titles);
      const previous = found.get(hit.suwayomiMangaId);
      if (score >= 0.45 && (!previous || previous.score < score))
        found.set(hit.suwayomiMangaId, { ...hit, title: result.titles[i], score });
    });
    if ([...found.values()].some((c) => c.score >= 0.9)) break;
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 4);
}
