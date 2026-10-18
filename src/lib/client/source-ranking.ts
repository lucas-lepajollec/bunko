import type { Source, SourceCandidate } from '@/types/shared';
import { compareSourceLanguage } from '../source-language';

interface SourceLane {
  source: Source;
  state: 'loading' | 'done' | 'error';
  result?: { results: unknown[] };
}
const laneRank = (lane: SourceLane) =>
  lane.state === 'error' ? 3 : lane.state === 'loading' ? 1 : lane.result?.results.length ? 0 : 2;

export function rankSourceLanes(a: SourceLane, b: SourceLane, language: string) {
  return laneRank(a) - laneRank(b) || compareSourceLanguage(a.source.lang, b.source.lang, language);
}

/** Match quality wins; then favor the interface language before chapter completeness. */
export function rankSourceCandidates(a: SourceCandidate, b: SourceCandidate, language: string) {
  return (
    b.score - a.score ||
    compareSourceLanguage(a.lang, b.lang, language) ||
    (b.chapterCount ?? -1) - (a.chapterCount ?? -1)
  );
}
