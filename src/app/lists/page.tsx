'use client';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useViewState } from '@/lib/client/view-state';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { ListsGrid, NewListDialog, isTierList, listInUniverse, useLists } from '@/components/lists';
import { useUniverse } from '@/lib/client/universe';
import { Empty, ErrorNote, PageTitle, Skeleton, cx, smallButton } from '@/components/ui';

const NONE: TrackedMedia[] = [];

export default function ListsPage() {
  return (
    <Suspense>
      <Lists />
    </Suspense>
  );
}

/** Lists and tier lists: two kinds, each in its own tab with its own way to start one. */
function Lists() {
  const { t, n } = useI18n();
  const router = useRouter();
  const lists = useLists();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const [tab, setTab] = useViewState<'lists' | 'tiers'>('tab', 'lists', ['lists', 'tiers']);
  const [creating, setCreating] = useState(false);
  const tier = tab === 'tiers';
  const universe = useUniverse();
  const entries = library.data ?? NONE;
  // The lists of the type on screen (and of the 18+ mode).
  const inView = (lists.data ?? []).filter((l) => listInUniverse(l, entries, universe.active));
  const shown = inView.filter((l) => isTierList(l) === tier);
  return (
    <Page>
      <PageTitle
        title={t('lists.title')}
        aside={lists.data ? t('lists.total', { count: n(inView.length) }) : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-seg flex rounded-full bg-white/[0.06] p-0.5 text-sm">
          {(['lists', 'tiers'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={cx(
                'h-9 rounded-full px-4',
                tab === k ? 'bg-fg text-bg font-semibold' : 'text-mid hover:text-white',
              )}
            >
              {t(k === 'lists' ? 'lists.title' : 'lists.tierLists')}
            </button>
          ))}
        </span>
        <button
          type="button"
          className={cx(smallButton, 'ml-auto')}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" aria-hidden />
          {t(tier ? 'lists.newTier' : 'lists.new')}
        </button>
      </div>
      {lists.error && <ErrorNote error={lists.error} />}
      {!lists.data && !lists.error && <Skeleton className="h-48 rounded-2xl" />}
      {lists.data && !shown.length && (
        <Empty title={t(tier ? 'lists.noTiers' : 'lists.none')}>
          {t(tier ? 'lists.noTiersBody' : 'lists.noneBody')}
        </Empty>
      )}
      <ListsGrid lists={shown} entries={entries} />
      <NewListDialog
        open={creating}
        tier={tier}
        onClose={() => setCreating(false)}
        onCreated={(list) => router.push(`/lists/${list.id}`)}
      />
    </Page>
  );
}
