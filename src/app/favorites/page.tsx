'use client';
import Link from 'next/link';
import type { TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
import { FavoriteButton } from '@/components/favorite';
import { Empty, ErrorNote, PageTitle, PosterSkeletons, smallButton } from '@/components/ui';

export default function FavoritesPage() {
  const { t, n } = useI18n();
  const library = useApi<TrackedMedia[]>('/api/tracked', {
    revalidateOnMount: true,
    revalidateOnFocus: true,
  });
  const entries = (library.data ?? []).filter((e) => e.favorite);
  return (
    <Page className="pb-16">
      <PageTitle
        title={t('favorites.title')}
        aside={library.data ? t('favorites.count', { count: n(entries.length) }) : undefined}
      />
      <Link href="/profile" className="text-mid self-start text-sm hover:text-white">
        ← {t('profile.title')}
      </Link>
      {library.error && <ErrorNote error={library.error} />}
      {library.data && !entries.length && (
        <Empty
          title={t('favorites.empty')}
          action={
            <Link href="/catalog" className={smallButton}>
              {t('library.browse')}
            </Link>
          }
        >
          {t('favorites.emptyBody')}
        </Empty>
      )}
      <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-8">
        {!library.data && !library.error && <PosterSkeletons count={8} />}
        {entries.map((entry) => (
          <article key={entry.id} className="relative min-w-0">
            <PosterCard media={entry.media} badge={<></>} />
            <FavoriteButton
              media={entry.media}
              entry={entry}
              className="absolute top-1 right-1 size-9 bg-bg/85"
            />
          </article>
        ))}
      </div>
    </Page>
  );
}
