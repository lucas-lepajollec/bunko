'use client';
import Link from 'next/link';
import type { AuthState, TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { continueReading } from '@/lib/client/reading';
import { useI18n } from '@/i18n/I18nProvider';
import { ReadingCard } from '@/components/reading';
import { Page } from '@/components/shell';
import {
  Empty,
  ErrorNote,
  PageTitle,
  SectionHeading,
  Skeleton,
  smallButton,
} from '@/components/ui';

export default function ProfilePage() {
  const { t, n } = useI18n();
  const auth = useApi<AuthState>('/api/auth');
  const library = useApi<TrackedMedia[]>('/api/tracked', {
    revalidateOnMount: true,
    revalidateOnFocus: true,
    dedupingInterval: 0,
  });
  const entries = library.data ?? [];
  const reading = continueReading(entries);
  return (
    <Page className="pb-16">
      <PageTitle title={t('profile.title')} aside={auth.data?.username} />
      <div className="flex flex-wrap items-center gap-3 text-sm text-mid">
        <span>{t('profile.followed', { count: n(entries.length) })}</span>
        <Link href="/favorites" className={smallButton}>
          {t('favorites.title')} · {n(entries.filter((e) => e.favorite).length)}
        </Link>
        <Link href="/library" className={smallButton}>
          {t('nav.library')}
        </Link>
        <Link href="/settings#account" className="ml-auto underline hover:text-white">
          {t('profile.account')}
        </Link>
      </div>
      <section id="continue" className="scroll-mt-28 flex flex-col gap-5">
        <SectionHeading title={t('home.resume')} aside={t('profile.recent')} />
        {library.error && <ErrorNote error={library.error} />}
        {!library.data && !library.error && <Skeleton className="h-36 rounded-2xl" />}
        {library.data && !reading.length && (
          <Empty title={t('profile.empty')}>{t('profile.emptyBody')}</Empty>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {reading.map((e) => (
            <ReadingCard key={e.id} entry={e} className="w-full md:w-full" />
          ))}
        </div>
      </section>
    </Page>
  );
}
