'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { GripVertical, Plus, Shuffle, Star, X } from 'lucide-react';
import type { ListLayout, ListTier, TrackedMedia, WorkList, WorkListItem } from '@/types/shared';
import { kindOfMedia } from '@/domain/kinds';
import { formatRating, libraryMark } from '@/domain/library-mark';
import { send, useApi } from '@/lib/client/api';
import { useSortable } from '@/lib/client/sortable';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { Duel } from '@/components/duel';
import { MediaLink } from '@/components/media-link';
import { PosterCard } from '@/components/media';
import { Select } from '@/components/select';
import { toast } from '@/components/notify';
import { listMeta, listName, listWorks, useListWrite, useLists } from '@/components/lists';
import {
  Cover,
  Empty,
  ErrorNote,
  Skeleton,
  cx,
  errorText,
  field,
  primaryButton,
  smallButton,
} from '@/components/ui';
import { useSWRConfig } from 'swr';

const TIERS: ListTier[] = ['S', 'A', 'B', 'C', 'D'];
const LAYOUTS: ListLayout[] = ['list', 'grid', 'tiers'];
type Work = { item: WorkListItem; entry: TrackedMedia };

export default function ListPage() {
  const { t, n, locale } = useI18n();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const params = useParams<{ id: string }>();
  const lists = useLists();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const write = useListWrite();
  const list = lists.data?.find((l) => l.id === Number(params.id));
  const entries = library.data ?? [];
  const works = list ? listWorks(list, entries) : [];
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [duel, setDuel] = useState<TrackedMedia | null>(null);
  const ids = works.map((w) => w.entry.id);
  const save = (patch: Record<string, unknown>) => (list ? write(list, patch) : null);
  const reorder = (next: number[]) => {
    // Shown at once; the server keeps it.
    if (list)
      void mutate(
        '/api/lists',
        (all: WorkList[] | undefined) =>
          all?.map((l) =>
            l.id === list.id
              ? {
                  ...l,
                  items: next.flatMap((id) => l.items.filter((i) => i.trackedId === id)),
                }
              : l,
          ),
        { revalidate: false },
      );
    void save({ order: next });
  };
  const sortable = useSortable(ids, reorder);
  const shown = sortable.order.flatMap((id) => works.filter((w) => w.entry.id === id));

  if (lists.error)
    return (
      <Page>
        <ErrorNote error={lists.error} />
      </Page>
    );
  if (!lists.data || !library.data)
    return (
      <Page>
        <Skeleton className="h-64 rounded-2xl" />
      </Page>
    );
  if (!list)
    return (
      <Page>
        <Empty title={t('lists.missing')} />
      </Page>
    );

  const ranked = list.ranked;
  const moveTo = (id: number, place: number) => {
    const next = ids.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(place - 1, next.length)), 0, id);
    reorder(next);
  };
  const byRating = () => {
    const rated = [...works].sort((a, b) => (b.entry.rating ?? -1) - (a.entry.rating ?? -1));
    reorder(rated.map((w) => w.entry.id));
  };

  const row = (w: Work, index: number) => (
    <li
      key={w.entry.id}
      ref={sortable.item(w.entry.id)}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-2xl px-2 py-2 md:gap-3',
        sortable.dragging === w.entry.id
          ? 'bg-white/[0.1] ring-2 ring-white/60'
          : 'hover:bg-white/[0.04]',
      )}
    >
      {editing && (
        <button
          type="button"
          aria-label={t('lists.drag', { title: w.entry.title })}
          className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:text-white"
          {...sortable.handle(w.entry.id)}
        >
          <GripVertical className="size-5" aria-hidden />
        </button>
      )}
      {ranked &&
        (editing ? (
          <input
            key={`${w.entry.id}:${index}`}
            defaultValue={index + 1}
            inputMode="numeric"
            aria-label={t('lists.place', { title: w.entry.title })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            onBlur={(e) => {
              const place = Number(e.currentTarget.value);
              if (Number.isInteger(place) && place > 0 && place !== index + 1)
                moveTo(w.entry.id, place);
              else e.currentTarget.value = String(index + 1);
            }}
            className="bg-raised font-display h-10 w-12 shrink-0 rounded-lg text-center text-lg font-extrabold tabular-nums outline-none focus:ring-2 focus:ring-white/50"
          />
        ) : (
          <span className="font-display w-10 shrink-0 text-right text-3xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums">
            {n(index + 1)}
          </span>
        ))}
      <MediaLink media={w.entry.media} className="flex min-w-0 flex-1 items-center gap-3 md:gap-4">
        <Cover
          src={w.entry.coverUrl ?? w.entry.media.coverUrl}
          fallbacks={w.entry.coverFallbacks}
          className="w-12 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{w.entry.title}</span>
          {!editing && w.item.note && (
            <span className="text-mid truncate font-serif text-[15px] italic">{w.item.note}</span>
          )}
        </span>
      </MediaLink>
      {editing && (
        <input
          defaultValue={w.item.note}
          maxLength={280}
          placeholder={t('lists.notePlaceholder')}
          aria-label={t('lists.note', { title: w.entry.title })}
          onBlur={(e) => {
            const note = e.currentTarget.value.trim();
            if (note !== w.item.note) void save({ items: [{ trackedId: w.entry.id, note }] });
          }}
          className={cx(field, 'hidden h-10 max-w-[260px] md:block')}
        />
      )}
      {w.entry.rating != null && (
        <span className="flex min-w-[58px] shrink-0 items-center justify-center gap-1 rounded-full bg-[#f5c518] px-2.5 py-1 text-sm font-bold text-black">
          <Star className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden />
          {formatRating(w.entry.rating, locale)}
        </span>
      )}
      {editing && list.layout === 'tiers' && (
        <Select
          label={t('lists.tier')}
          value={w.item.tier ?? ''}
          size="sm"
          onChange={(v) =>
            void save({ items: [{ trackedId: w.entry.id, tier: (v || null) as ListTier | null }] })
          }
          options={[{ value: '', label: '—' }, ...TIERS.map((x) => ({ value: x, label: x }))]}
        />
      )}
      {editing && ranked && works.length > 1 && (
        <button
          type="button"
          onClick={() => setDuel(w.entry)}
          aria-label={t('lists.duel', { title: w.entry.title })}
          title={t('lists.duelShort')}
          className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
        >
          <Shuffle className="size-4" aria-hidden />
        </button>
      )}
      {editing && (
        <button
          type="button"
          onClick={() => void save({ remove: [w.entry.id] })}
          aria-label={t('lists.remove', { title: w.entry.title })}
          className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </li>
  );

  const grid = (items: Work[]) => (
    <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] xl:grid-cols-8">
      {items.map((w) => {
        const index = shown.indexOf(w);
        return (
          <article
            key={w.entry.id}
            ref={sortable.item(w.entry.id)}
            className={cx(
              'relative min-w-0 rounded-xl',
              sortable.dragging === w.entry.id && 'ring-2 ring-white/60',
            )}
          >
            {ranked && (
              <span className="font-display text-mid mb-1 block text-2xl leading-none font-extrabold tracking-[-0.04em] tabular-nums">
                {n(index + 1)}
              </span>
            )}
            <PosterCard media={{ ...w.entry.media, mine: libraryMark(w.entry) }} badge={<></>} />
            {editing && (
              <button
                type="button"
                aria-label={t('lists.drag', { title: w.entry.title })}
                className="bg-bg/85 absolute top-1 right-1 flex size-9 items-center justify-center rounded-full"
                {...sortable.handle(w.entry.id)}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>
            )}
          </article>
        );
      })}
    </div>
  );

  return (
    <Page className="pb-24">
      <div className="flex flex-col gap-2">
        <span className="text-muted text-xs tracking-[0.06em] uppercase">
          {listMeta(t, n, list, works.length)}
        </span>
        <h1 className="font-display text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-[56px]">
          {listName(t, list)}
        </h1>
        {list.description && (
          <p className="text-mid max-w-2xl font-serif text-xl italic">{list.description}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={smallButton} onClick={() => setAdding(true)}>
          <Plus className="size-4" aria-hidden />
          {t('lists.addWorks')}
        </button>
        {ranked && works.some((w) => w.entry.rating != null) && (
          <button
            type="button"
            className={smallButton}
            onClick={() => window.confirm(t('lists.byRatingConfirm')) && byRating()}
          >
            {t('lists.byRating')}
          </button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={list.layout === l}
              onClick={() => void save({ layout: l })}
              className={cx(
                'h-9 rounded-full px-3.5 text-[13px]',
                list.layout === l ? 'bg-fg text-bg font-semibold' : 'text-mid hover:text-white',
              )}
            >
              {t(`lists.layout.${l}`)}
            </button>
          ))}
        </span>
        <button
          type="button"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
          className={cx(smallButton, editing && 'bg-fg text-bg hover:bg-fg')}
        >
          {editing ? t('tops.done') : t('lists.edit')}
        </button>
      </div>
      {editing && (
        <div className="text-mid flex flex-wrap items-center gap-3 text-sm">
          <span>{t(ranked ? 'lists.editHint' : 'lists.editHintFree')}</span>
          <span className="ml-auto flex gap-2">
            {!list.system && (
              <button type="button" className={smallButton} onClick={() => setRenaming(true)}>
                {t('lists.settings')}
              </button>
            )}
            {!list.system && (
              <button
                type="button"
                className={cx(smallButton, 'text-bad')}
                onClick={async () => {
                  if (!window.confirm(t('lists.deleteConfirm', { name: list.name }))) return;
                  try {
                    await mutate(
                      '/api/lists',
                      await send<WorkList[]>(`/api/lists/${list.id}`, 'DELETE'),
                      {
                        revalidate: false,
                      },
                    );
                    router.push('/lists');
                  } catch (e) {
                    toast({ tone: 'bad', text: errorText(t, e) });
                  }
                }}
              >
                {t('tops.delete')}
              </button>
            )}
          </span>
        </div>
      )}
      {!works.length && (
        <Empty
          title={t('lists.empty')}
          action={
            <button type="button" className={smallButton} onClick={() => setAdding(true)}>
              {t('lists.addWorks')}
            </button>
          }
        >
          {t('lists.emptyBody')}
        </Empty>
      )}
      {list.layout === 'grid' && grid(shown)}
      {list.layout === 'list' && (
        <ol className="flex max-w-4xl flex-col gap-1">{shown.map((w, i) => row(w, i))}</ol>
      )}
      {list.layout === 'tiers' &&
        [...TIERS, null].map((tier) => {
          const inTier = shown.filter((w) => (w.item.tier ?? null) === tier);
          if (!inTier.length && (tier === null || !editing)) return null;
          return (
            <section key={tier ?? 'none'} className="flex flex-col gap-3 md:flex-row md:gap-5">
              <span
                className={cx(
                  'font-display flex h-12 w-16 shrink-0 items-center justify-center rounded-xl text-2xl font-extrabold md:h-auto md:min-h-24',
                  tier ? 'bg-white/[0.08]' : 'text-mid bg-white/[0.03] text-sm',
                )}
              >
                {tier ?? t('lists.noTier')}
              </span>
              <div className="min-w-0 flex-1">
                {editing ? (
                  <ol className="flex flex-col gap-1">
                    {inTier.map((w) => row(w, shown.indexOf(w)))}
                  </ol>
                ) : (
                  grid(inTier)
                )}
              </div>
            </section>
          );
        })}
      <AddWorks
        open={adding}
        onClose={() => setAdding(false)}
        entries={entries.filter(
          (e) =>
            !e.partOf && !ids.includes(e.id) && (!list.kind || kindOfMedia(e.media) === list.kind),
        )}
        onAdd={async (work) => {
          const fresh = await save({ add: [work.id] });
          const now = fresh?.find((l) => l.id === list.id);
          if (now?.ranked && now.items.length > 1) {
            setAdding(false);
            setDuel(work);
          }
        }}
      />
      {renaming && <ListSettings list={list} onClose={() => setRenaming(false)} onSave={save} />}
      {duel && (
        <Duel
          title={listName(t, list)}
          sorted={works.map((w) => w.entry).filter((w) => w.id !== duel.id)}
          pending={[duel]}
          onCancel={() => setDuel(null)}
          onDone={(order) => {
            reorder(order);
            setDuel(null);
          }}
        />
      )}
    </Page>
  );
}

/** Library works to add, filtered by typing. */
function AddWorks({
  open,
  onClose,
  entries,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  entries: TrackedMedia[];
  onAdd: (work: TrackedMedia) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const fold = (v: string) => v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const found = (
    q.trim() ? entries.filter((e) => fold(e.title).includes(fold(q.trim()))) : entries
  ).slice(0, 40);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-3 top-[8vh] z-50 mx-auto flex max-h-[84vh] max-w-[520px] flex-col gap-3 rounded-3xl border p-5 outline-none">
          <Dialog.Title className="font-display text-[22px] font-extrabold tracking-[-0.03em]">
            {t('lists.addWorks')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t('lists.addWorksHint')}
          </Dialog.Description>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('tops.addPlaceholder')}
            aria-label={t('lists.addWorks')}
            autoFocus
            className={field}
          />
          <div className="-mx-2 flex min-h-0 flex-col overflow-y-auto overscroll-contain">
            {found.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onAdd(e)}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]"
              >
                <Cover
                  src={e.coverUrl ?? e.media.coverUrl}
                  fallbacks={e.coverFallbacks}
                  className="w-8 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <Plus className="text-mid size-4 shrink-0" aria-hidden />
              </button>
            ))}
            {!found.length && <p className="text-muted px-2 py-4 text-sm">{t('lists.noMatch')}</p>}
          </div>
          <button type="button" className={cx(smallButton, 'self-end')} onClick={onClose}>
            {t('tops.done')}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ListSettings({
  list,
  onClose,
  onSave,
}: {
  list: WorkList;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => unknown;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description);
  const [ranked, setRanked] = useState(list.ranked);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[440px] -translate-y-1/2 flex-col gap-4 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] font-extrabold tracking-[-0.03em]">
            {t('lists.settings')}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{t('lists.newHint')}</Dialog.Description>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={t('lists.name')}
            maxLength={80}
            className={field}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label={t('lists.description')}
            placeholder={t('lists.description')}
            maxLength={500}
            rows={3}
            className={cx(field, 'h-auto py-2.5')}
          />
          <Select
            label={t('lists.order')}
            value={ranked ? 'ranked' : 'free'}
            onChange={(v) => setRanked(v === 'ranked')}
            options={[
              { value: 'ranked', label: t('lists.ranked') },
              { value: 'free', label: t('lists.unranked') },
            ]}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={smallButton} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!name.trim()}
              className={primaryButton}
              onClick={async () => {
                await onSave({ name: name.trim(), description: description.trim(), ranked });
                onClose();
              }}
            >
              {t('common.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
