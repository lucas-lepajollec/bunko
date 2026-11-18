'use client';
import { useLook } from '@/lib/client/theme';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Plus } from 'lucide-react';
import type { AuthState, TrackedMedia, WorkList } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { universeAsides, useUniverse } from '@/lib/client/universe';
import { useViewState } from '@/lib/client/view-state';
import { useI18n } from '@/i18n/I18nProvider';
import { kindOfMedia } from '@/domain/kinds';
import { ContinueCard, useContinue } from '@/components/reading';
import { PosterCard } from '@/components/media';
import { libraryMark } from '@/domain/library-mark';
import { Tops } from '@/components/tops';
import { ListsGrid, NewListDialog, listInUniverse, listWorks, useLists } from '@/components/lists';
import { Page } from '@/components/shell';
import {
  Empty,
  ErrorNote,
  PageTitle,
  SectionHeading,
  Skeleton,
  cx,
  smallButton,
} from '@/components/ui';

/** Long sections scroll inside themselves past a few rows, so the page stays short. */
const scrollBox = 'max-h-[min(70vh,720px)] overflow-y-auto overscroll-contain pr-1';
const FAVORITES_SHOWN = 5;

export default function ProfilePage() {
  const { t, n } = useI18n();
  const look = useLook();
  const router = useRouter();
  const auth = useApi<AuthState>('/api/auth');
  const library = useApi<TrackedMedia[]>('/api/tracked', {
    revalidateOnMount: true,
    revalidateOnFocus: true,
    dedupingInterval: 0,
  });
  const lists = useLists();
  const entries = library.data ?? [];
  // Everything in progress for the universe on screen, followed or not.
  const resume = useContinue();
  const favoritesList = lists.data?.find((l) => l.system === 'favorites');
  const universe = useUniverse();
  // The lists of the type on screen (and of the 18+ mode).
  const own = (lists.data ?? []).filter(
    (l) => !l.system && listInUniverse(l, entries, universe.active),
  );
  const [creating, setCreating] = useState(false);
  // The profile's subtitle says reading, watching or both.
  const recent = universeAsides(universe.active, universe.enabled).recent;
  return (
    <Page className="pb-16">
      {look === 'bunko' ? (
        <>
          <PageTitle title={t('profile.title')} aside={auth.data?.username} />
          <div className="text-mid flex flex-wrap items-center gap-3 text-sm">
            <span>{t('profile.followed', { count: n(entries.length) })}</span>
            <Link href="#favorites" className={smallButton}>
              {t('favorites.title')}
              {favoritesList ? ` · ${n(listWorks(favoritesList, entries).length)}` : ''}
            </Link>
            <Link href="#tops" className={smallButton}>
              {t('tops.title')}
            </Link>
            <Link href="#lists" className={smallButton}>
              {t('lists.title')} · {n(own.length)}
            </Link>
            <Link href="/library" className={smallButton}>
              {t('nav.library')}
            </Link>
            <Link href="/settings#account" className="ml-auto underline hover:text-white">
              {t('profile.account')}
            </Link>
          </div>
        </>
      ) : (
        // Themes: a member card — initial, name, what is followed, then the same shortcuts.
        <section
          className={cx(
            'flex flex-col gap-5 md:flex-row md:items-center md:gap-7',
            look === 'edition' && 'border-fg border-b pb-7',
            look === 'aurore' && 'ui-panel rounded-[28px] border p-5 md:p-7',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'font-display flex size-20 shrink-0 items-center justify-center text-[38px] uppercase md:size-28 md:text-[52px]',
              look === 'edition'
                ? 'border-fg border text-(--tone)'
                : 'text-on-bright rounded-full bg-(--tone)',
            )}
          >
            {(auth.data?.username ?? '·').slice(0, 1)}
          </span>
          <span className="flex min-w-0 flex-col gap-1.5">
            {look === 'edition' && (
              <span className="text-[11px] tracking-[0.16em] text-(--tone) uppercase">
                {t('profile.title')}
              </span>
            )}
            <h1 className="font-display truncate text-[44px] leading-[0.9] md:text-[72px]">
              {auth.data?.username ?? t('profile.title')}
            </h1>
            <span className="text-muted text-sm">
              {t('profile.followed', { count: n(entries.length) })}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2 md:ml-auto md:justify-end">
            <Link href="#favorites" className={smallButton}>
              {t('favorites.title')}
              {favoritesList ? ` · ${n(listWorks(favoritesList, entries).length)}` : ''}
            </Link>
            <Link href="#tops" className={smallButton}>
              {t('tops.title')}
            </Link>
            <Link href="#lists" className={smallButton}>
              {t('lists.title')} · {n(own.length)}
            </Link>
            <Link href="/library" className={smallButton}>
              {t('nav.library')}
            </Link>
            <Link href="/settings#account" className={smallButton}>
              {t('profile.account')}
            </Link>
          </span>
        </section>
      )}
      <section id="continue" className="flex scroll-mt-28 flex-col gap-5">
        <SectionHeading title={t('home.resume')} aside={t(recent)} />
        {resume.error && <ErrorNote error={resume.error} />}
        {!resume.data && !resume.error && <Skeleton className="h-36 rounded-2xl" />}
        {resume.data && !resume.shown.length && (
          <Empty title={t('profile.empty')}>{t('profile.emptyBody')}</Empty>
        )}
        <div className={cx('grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', scrollBox)}>
          {resume.shown.map((item) => (
            <ContinueCard key={item.media.id} item={item} className="w-full md:w-full" />
          ))}
        </div>
      </section>
      <Favorites list={favoritesList} entries={entries} loading={!library.data || !lists.data} />
      <Suspense>
        <Tops entries={entries} />
      </Suspense>
      <section id="lists" className="flex scroll-mt-28 flex-col gap-5">
        <SectionHeading
          title={t('lists.mine')}
          aside={lists.data ? t('lists.total', { count: n(own.length) }) : undefined}
          href="/lists"
          linkLabel={t('lists.all')}
        />
        <div>
          <button type="button" className={smallButton} onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            {t('lists.new')}
          </button>
        </div>
        {lists.error && <ErrorNote error={lists.error} />}
        {lists.data && !own.length && <Empty title={t('lists.none')}>{t('lists.noneBody')}</Empty>}
        <div className={scrollBox}>
          <ListsGrid lists={own} entries={entries} />
        </div>
        <NewListDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(list) => router.push(`/lists/${list.id}`)}
        />
      </section>
    </Page>
  );
}

/** The favorites: the first five of each kind, in the user's order. */
function Favorites({
  list,
  entries,
  loading,
}: {
  list: WorkList | undefined;
  entries: TrackedMedia[];
  loading: boolean;
}) {
  const { t, n } = useI18n();
  const look = useLook();
  const universe = useUniverse();
  const works = list ? listWorks(list, entries).map((w) => w.entry) : [];
  const kinds = universe.order.filter((k) => works.some((w) => kindOfMedia(w.media) === k));
  const [chosen, setChosen] = useViewState<string>('fav', '');
  // Opens on the type on screen when it has favorites.
  const kind =
    kinds.find((k) => k === chosen) ?? kinds.find((k) => k === universe.active) ?? kinds[0];
  const ofKind = works.filter((w) => kindOfMedia(w.media) === kind);
  return (
    <section id="favorites" className="flex scroll-mt-28 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SectionHeading title={t('favorites.title')} aside={t('favorites.aside')} />
        {list && works.length > 0 && (
          <span className="ml-auto flex items-center gap-3">
            <Link href={`/lists/${list.id}`} className={smallButton}>
              {t('favorites.reorder')}
            </Link>
            <Link href={`/lists/${list.id}`} className="text-muted hover:text-fg text-[13px]">
              {t('favorites.all', { count: n(works.length) })} →
            </Link>
          </span>
        )}
      </div>
      {loading && <Skeleton className="h-36 rounded-2xl" />}
      {!loading && !works.length && (
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
      {kinds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === kind}
              onClick={() => setChosen(k)}
              className={cx(
                'h-[34px] rounded-full px-3.5 transition-colors',
                k === kind ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
              )}
            >
              {t(`kind.${k}`)}
            </button>
          ))}
        </div>
      )}
      <ol
        key={kind}
        className="anim-rise grid max-w-[1100px] grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-5 md:gap-x-[26px]"
      >
        {ofKind.slice(0, FAVORITES_SHOWN).map((entry, i) => (
          <li
            key={entry.id}
            className={cx(
              'relative flex min-w-0 flex-col gap-1',
              look === 'cine' && 'pl-[18%] [&>a]:relative [&>a]:z-[1]',
            )}
          >
            <span
              className={cx(
                'font-display leading-none tabular-nums',
                look === 'cine'
                  ? 'top-numeral absolute bottom-[38px] left-[-4%] text-[110px] md:text-[150px]'
                  : look === 'edition'
                    ? 'text-[36px] text-(--tone) md:text-[44px]'
                    : 'text-mid text-2xl font-extrabold tracking-[-0.04em] md:text-3xl',
              )}
            >
              {n(i + 1)}
            </span>
            <PosterCard media={{ ...entry.media, mine: libraryMark(entry) }} badge={<></>} />
          </li>
        ))}
      </ol>
    </section>
  );
}
