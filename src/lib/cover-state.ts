import type { CoverChoice, ChapterSelection } from '@/types/shared';
/** Metadata/thumbnail refreshes do not change a validated cover's identity. */
export function coverContext(
  id: string,
  identity: string,
  choice: CoverChoice,
  sources: ChapterSelection[],
  seriesId: number | null,
) {
  return JSON.stringify([
    id,
    identity,
    choice,
    sources.map((s) => [s.sourceId, s.suwayomiMangaId]),
    seriesId,
  ]);
}
