import type { MediaDetail, SourceCandidate } from '@/types/shared';
import type { MatchingSource } from './suwayomi';
import { eachConcurrent } from './concurrency';
import { normalizeTitle } from './media';
import { matchOnSource } from './matching';

const extensionKey = (s: MatchingSource) =>
  JSON.stringify(s.extensionId ? ['extension', s.extensionId] : ['source', s.id]);

/** Input source order is language preference order, never response completion order. */
export function deduplicateCandidates(candidates: SourceCandidate[], sources: MatchingSource[]) {
  const pairs = new Set<string>();
  const titles = new Map<string, string>();
  return sources.flatMap((source) =>
    candidates.filter((candidate) => {
      if (candidate.sourceId !== source.id) return false;
      const pair = JSON.stringify([candidate.sourceId, candidate.suwayomiMangaId]);
      if (pairs.has(pair)) return false;
      pairs.add(pair);
      const title = normalizeTitle(candidate.title);
      if (!title) return true;
      const key = JSON.stringify([extensionKey(source), title]);
      const language = titles.get(key);
      if (language !== undefined && language !== source.lang) return false;
      titles.set(key, source.lang);
      return true;
    }),
  );
}

/** Resolve sibling variants in preference order; unrelated extensions stream independently. */
export async function scanMatchingSources(
  sources: MatchingSource[],
  media: Pick<MediaDetail, 'title' | 'altTitles'>,
  signal?: AbortSignal,
  onMatch: (
    source: MatchingSource,
    candidates: SourceCandidate[],
    durationMs: number,
  ) => void = () => {},
  onError: (source: MatchingSource, error: unknown) => void = () => {},
) {
  const groups = new Map<string, MatchingSource[]>();
  for (const source of sources) {
    const key = extensionKey(source);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  const found: SourceCandidate[] = [];
  await eachConcurrent(
    [...groups.values()],
    6,
    async (group) => {
      const pending = group.map(async (source) => {
        const start = Date.now();
        try {
          const candidates = await matchOnSource(source, media, signal);
          return { source, candidates, durationMs: Date.now() - start };
        } catch (error) {
          onError(source, error);
          return null;
        }
      });
      const accepted: SourceCandidate[] = [];
      for (const promise of pending) {
        const result = await promise;
        signal?.throwIfAborted();
        if (!result) continue;
        const kept = deduplicateCandidates([...accepted, ...result.candidates], group).filter(
          (c) => c.sourceId === result.source.id,
        );
        accepted.push(...kept);
        onMatch(result.source, kept, result.durationMs);
      }
      found.push(...accepted);
    },
    signal,
  );
  return deduplicateCandidates(found, sources);
}
