import type { UnifiedMedia, ChapterSelection, TrackedMedia, Source } from '@/types/shared';
import { statement, writeVersion, db } from './db';
import { getSettings } from './settings';

let flags: { version: number; values: Map<string, boolean> } | undefined;
function sourceFlags() {
  const version = writeVersion();
  if (flags?.version === version) return flags.values;
  const values = new Map(
    (statement('SELECT id,nsfw FROM source_flags').all() as { id: string; nsfw: number }[]).map(
      (r) => [r.id, Boolean(r.nsfw)],
    ),
  );
  if (!db().inTransaction) flags = { version, values };
  return values;
}
export function recordSourceFlags(sources: Source[]) {
  db().transaction(() => {
    for (const s of sources)
      statement(
        'INSERT INTO source_flags(id,nsfw) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nsfw=excluded.nsfw WHERE nsfw<>excluded.nsfw',
      ).run(s.id, Number(Boolean(s.nsfw)));
  })();
}
export function adultClassifier() {
  const flags = sourceFlags();
  return (
    media: UnifiedMedia,
    sources: Pick<ChapterSelection, 'sourceId'>[] = media.sources,
  ): boolean => {
    if (media.adult || (media.genres ?? []).some((g) => /^(adult|hentai|smut)$/i.test(g)))
      return true;
    const ids = (sources ?? []).map((s) => s.sourceId);
    return ids.length > 0 && ids.every((id) => flags.get(id) === true);
  };
}
export function mediaAdult(
  media: UnifiedMedia,
  sources: Pick<ChapterSelection, 'sourceId'>[] = media.sources,
) {
  return adultClassifier()(media, sources);
}
export function mediaVisibility() {
  const enabled = getSettings().adultContent;
  const classify = adultClassifier();
  return (media: UnifiedMedia) => enabled || !classify(media);
}
export function visibleMedia(media: UnifiedMedia) {
  return mediaVisibility()(media);
}
export function visibleTracked(entries: TrackedMedia[]) {
  return getSettings().adultContent
    ? entries
    : (() => {
        const classify = adultClassifier();
        return entries.filter((t) => !classify(t.media, t.sources));
      })();
}
export function sourceAllowed(source: Source) {
  return getSettings().adultContent || !(source.nsfw ?? sourceFlags().get(source.id));
}
