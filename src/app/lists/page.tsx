'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { ListsGrid, NewListDialog, useLists } from '@/components/lists';
import { ErrorNote, PageTitle, Skeleton, smallButton } from '@/components/ui';

export default function ListsPage() {
  const { t, n } = useI18n();
  const router = useRouter();
  const lists = useLists();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const [creating, setCreating] = useState(false);
  return (
    <Page>
      <PageTitle
        title={t('lists.title')}
        aside={lists.data ? t('lists.total', { count: n(lists.data.length) }) : undefined}
      />
      <div>
        <button type="button" className={smallButton} onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden />
          {t('lists.new')}
        </button>
      </div>
      {lists.error && <ErrorNote error={lists.error} />}
      {!lists.data && !lists.error && <Skeleton className="h-48 rounded-2xl" />}
      <ListsGrid lists={lists.data ?? []} entries={library.data ?? []} />
      <NewListDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(list) => router.push(`/lists/${list.id}`)}
      />
    </Page>
  );
}
