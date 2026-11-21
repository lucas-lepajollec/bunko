'use client';
import { SlidingHighlight } from '@/components/sliding-highlight';
import { useLook } from '@/lib/client/theme';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { AuthState, ContinueItem, TrackedMedia, WorkList } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { choiceLabel, universeAsides, useUniverse } from '@/lib/client/universe';
import { useViewState } from '@/lib/client/view-state';
import { useI18n } from '@/i18n/I18nProvider';
import { NO_SECTION, inKindScope } from '@/domain/kinds';
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
    (l) => !l.system && listInUniverse(l, entries, universe.scope),
  );
  const [creating, setCreating] = useState(false);
  // The profile's subtitle says reading, watching or both.
  const asides = universeAsides(universe.active, universe.enabled);
  return (
    <Page className={cx('pb-16', look === 'cine' && 'gap-14 md:gap-20')}>
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
        <section className="flex flex-col gap-5 md:flex-row md:items-center md:gap-7">
          <span
            aria-hidden
            className="font-display flex size-20 shrink-0 items-center justify-center rounded-full bg-white text-[38px] text-[#070b10] uppercase md:size-28 md:text-[52px]"
          >
            {(auth.data?.username ?? '·').slice(0, 1)}
          </span>
          <span className="flex min-w-0 flex-col gap-1.5">
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
        <SectionHeading title={t('home.resume')} aside={t(asides.recent)} />
        {resume.error && <ErrorNote error={resume.error} />}
        {!resume.data && !resume.error && <Skeleton className="h-36 rounded-2xl" />}
        {resume.data && !resume.shown.length && (
          <Empty title={t(asides.empty)}>{t(asides.emptyBody)}</Empty>
        )}
        <ResumeGrid items={resume.shown} />
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

/**
 * Everything in progress: the first rows, then "see all" turns the grid into a box of the same
 * height that scrolls (nothing below moves), as the rankings do.
 */
function ResumeGrid({ items }: { items: ContinueItem[] }) {
  const { t, n } = useI18n();
  const look = useLook();
  const [all, setAll] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const first = look === 'cine' ? 12 : 8;
  const shown = all ? items : items.slice(0, first);
  return (
    <>
      <div
        ref={grid}
        style={all && height ? { maxHeight: height } : undefined}
        className={cx(
          'grid',
          look === 'cine'
            ? 'grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-6 xl:grid-cols-8'
            : 'gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
          all && 'overflow-y-auto overscroll-contain pr-1',
        )}
      >
        {shown.map((item) => (
          <ContinueCard key={item.media.id} item={item} className="w-full md:w-full" />
        ))}
      </div>
      {items.length > first && (
        <button
          type="button"
          className={cx(smallButton, 'self-start')}
          onClick={() => {
            if (!all) setHeight(grid.current?.offsetHeight ?? null);
            setAll(!all);
          }}
        >
          {all ? t('profile.resumeLess') : t('tops.all', { count: n(items.length) })}
        </button>
      )}
    </>
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
  // One tab per kind, the extension kind one per section (as in the kind menu), plus one for
  // its works filed under no section.
  const keyOf = (c: { kind: string; section: string | null }) =>
    c.section ? `${c.kind}:${c.section}` : c.kind;
  const tabs = [
    ...universe.choices(universe.order),
    ...(universe.sections.length
      ? [{ kind: 'extension' as const, section: NO_SECTION, name: null }]
      : []),
  ].filter((c) => works.some((w) => inKindScope(w.media, { kind: c.kind, section: c.section })));
  const [chosen, setChosen] = useViewState<string>('fav', '');
  // Opens on the type (and section) on screen when it has favorites.
  const tab =
    tabs.find((c) => keyOf(c) === chosen) ??
    tabs.find((c) => c.kind === universe.active && c.section === universe.section) ??
    tabs.find((c) => c.kind === universe.active) ??
    tabs[0];
  const kind = tab ? keyOf(tab) : undefined;
  const ofKind = tab
    ? works.filter((w) => inKindScope(w.media, { kind: tab.kind, section: tab.section }))
    : [];
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
      {tabs.length > 1 && (
        <div className="relative flex flex-wrap items-center gap-1 text-sm">
          <SlidingHighlight />
          {tabs.map((c) => (
            <button
              key={keyOf(c)}
              type="button"
              aria-pressed={keyOf(c) === kind}
              onClick={() => setChosen(keyOf(c))}
              className={cx(
                'h-[34px] rounded-full px-3.5 transition-colors',
                keyOf(c) === kind ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
              )}
            >
              {choiceLabel(t, c)}
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
                  : 'text-mid text-2xl font-extrabold tracking-[-0.04em] md:text-3xl',
              )}
            >
              {n(i + 1)}
            </span>
            <PosterCard media={{ ...entry.media, mine: libraryMark(entry) }} />
          </li>
        ))}
      </ol>
    </section>
  );
}
