'use client';
import type { TrackedMedia } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';

/** Stock is independent of the unit chosen for reading progress. Never add chapters to volumes. */
export function OwnedInventory({
  entry,
  compact = false,
}: {
  entry: TrackedMedia;
  compact?: boolean;
}) {
  const { t, n } = useI18n();
  const chapters = entry.ownedChapterCount ?? (entry.unit === 'volume' ? 0 : entry.progress.owned);
  const volumes =
    entry.ownedVolumes?.length ?? (entry.unit === 'volume' ? entry.progress.owned : 0);
  const parts = [
    ...(chapters > 0
      ? [t(compact ? 'library.ownedN' : 'title.ownedChapters', { n: n(chapters) })]
      : []),
    ...(volumes > 0
      ? [t(compact ? 'library.ownedNVol' : 'title.ownedVol', { n: n(volumes) })]
      : []),
  ];
  return (
    <span>
      {parts.length
        ? parts.join(' · ')
        : t(compact ? 'library.ownedN' : 'title.owned', { n: n(0) })}
    </span>
  );
}
