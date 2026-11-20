'use client';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { memo, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import {
  ArrowLeft,
  GripVertical,
  LayoutGrid,
  List as ListIcon,
  Plus,
  Search,
  Settings2,
  Star,
  X,
} from 'lucide-react';
import type { ListTier, TierRow, TrackedMedia, WorkList, WorkListItem } from '@/types/shared';
import { kindOfMedia } from '@/domain/kinds';
import { formatRating, libraryMark } from '@/domain/library-mark';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { Duel } from '@/components/duel';
import { MediaLink } from '@/components/media-link';
import { PosterCard } from '@/components/media';
import { Select } from '@/components/select';
import {
  SortableList,
  buttonInDraggable,
  fieldInDraggable,
  useSortableItem,
} from '@/components/sortable';
import { tierOfRating } from '@/domain/tiers';
import { TierBoard } from '@/components/tier-board';
import { toast } from '@/components/notify';
import {
  isTierList,
  listMeta,
  listName,
  listWorks,
  useListWrite,
  useLists,
} from '@/components/lists';
import {
  Cover,
  Empty,
  ErrorNote,
  Skeleton,
  cx,
  errorText,
  field,
  primarySmall,
  smallButton,
} from '@/components/ui';

type Work = { item: WorkListItem; entry: TrackedMedia };
const NONE: TrackedMedia[] = [];

export default function ListPage() {
  const { t, n } = useI18n();
  const { mutate } = useSWRConfig();
  const params = useParams<{ id: string }>();
  const lists = useLists();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const write = useListWrite();
  const list = lists.data?.find((l) => l.id === Number(params.id));
  const entries = library.data ?? NONE;
  const works = useMemo(() => (list ? listWorks(list, entries) : []), [list, entries]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [duel, setDuel] = useState<TrackedMedia | null>(null);

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
        <BackLink />
        <Empty title={t('lists.missing')} />
      </Page>
    );

  const tier = isTierList(list);
  const ids = works.map((w) => w.entry.id);
  /** Writes at once in the cache (no jump back while the server saves), then on the server. */
  const patch = (next: (l: WorkList) => WorkList, body: Record<string, unknown>) => {
    void mutate(
      '/api/lists',
      (all: WorkList[] | undefined) => all?.map((l) => (l.id === list.id ? next(l) : l)),
      { revalidate: false },
    );
    void write(list, body);
  };
  const reorder = (order: number[]) =>
    patch(
      (l) => ({ ...l, items: order.flatMap((id) => l.items.filter((i) => i.trackedId === id)) }),
      { order },
    );
  const remove = (trackedId: number) =>
    patch((l) => ({ ...l, items: l.items.filter((i) => i.trackedId !== trackedId) }), {
      remove: [trackedId],
    });
  const setNote = (trackedId: number, note: string) =>
    patch(
      (l) => ({
        ...l,
        items: l.items.map((i) => (i.trackedId === trackedId ? { ...i, note } : i)),
      }),
      { items: [{ trackedId, note }] },
    );
  const saveTiers = (order: number[], changed: { trackedId: number; tier: ListTier | null }[]) => {
    const tiers = new Map(changed.map((c) => [c.trackedId, c.tier]));
    patch(
      (l) => ({
        ...l,
        items: order.flatMap((id) =>
          l.items
            .filter((i) => i.trackedId === id)
            .map((i) => (tiers.has(id) ? { ...i, tier: tiers.get(id) ?? null } : i)),
        ),
      }),
      { order, ...(changed.length ? { items: changed } : {}) },
    );
  };
  const saveRows = (tiers: TierRow[]) => {
    const ids = new Set(tiers.map((x) => x.id));
    patch(
      (l) => ({
        ...l,
        tiers,
        items: l.items.map((i) => (i.tier && !ids.has(i.tier) ? { ...i, tier: null } : i)),
      }),
      { tiers },
    );
  };
  const placeByRating = () => {
    const changed = works.flatMap((w) => {
      const tierOf = w.item.tier ? null : tierOfRating(w.entry.rating, list.tiers);
      return tierOf ? [{ trackedId: w.entry.id, tier: tierOf }] : [];
    });
    if (changed.length) saveTiers(ids, changed);
  };
  const unplacedRated = tier && works.some((w) => !w.item.tier && w.entry.rating != null);

  return (
    <Page className="pb-24">
      <BackLink tier={tier} />
      <div className="-mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-display max-w-full text-[36px] leading-[0.95] font-extrabold tracking-[-0.04em] [overflow-wrap:anywhere] md:text-[56px]">
            {listName(t, list)}
          </h1>
          <span className="text-muted font-serif text-[17px] italic md:text-[22px]">
            {listMeta(t, n, list, works.length)}
          </span>
        </div>
        {list.description && (
          <p className="text-mid max-w-2xl font-serif text-xl italic">{list.description}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={smallButton} onClick={() => setAdding(true)}>
          <Plus className="size-4" aria-hidden />
          <span className="md:hidden">{t('lists.addShort')}</span>
          <span className="hidden md:inline">{t('lists.addWorks')}</span>
        </button>
        {unplacedRated && (
          <button type="button" className={smallButton} onClick={placeByRating}>
            <span className="md:hidden">{t('lists.placeShort')}</span>
            <span className="hidden md:inline">{t('lists.placeByRating')}</span>
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {!tier && !editing && (
            <span className="flex rounded-full bg-white/[0.06] p-0.5">
              {(['list', 'grid'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={list.layout === l}
                  aria-label={t(`lists.layout.${l}`)}
                  onClick={() => patch((x) => ({ ...x, layout: l }), { layout: l })}
                  className={cx(
                    'flex h-8 items-center rounded-full px-2.5 text-[13px] transition-colors md:px-3.5',
                    list.layout === l ? 'bg-fg text-bg font-semibold' : 'text-mid hover:text-white',
                  )}
                >
                  {l === 'list' ? (
                    <ListIcon className="size-4 md:hidden" aria-hidden />
                  ) : (
                    <LayoutGrid className="size-4 md:hidden" aria-hidden />
                  )}
                  <span className="hidden md:inline">{t(`lists.layout.${l}`)}</span>
                </button>
              ))}
            </span>
          )}
          {!list.system && (
            <button
              type="button"
              aria-label={t('lists.settings')}
              className={cx(smallButton, 'max-md:w-9 max-md:px-0')}
              onClick={() => setSettings(true)}
            >
              <Settings2 className="size-4 md:hidden" aria-hidden />
              <span className="hidden md:inline">{t('lists.settings')}</span>
            </button>
          )}
          {(tier || works.length > 0) && (
            <button
              type="button"
              aria-pressed={editing}
              onClick={() => setEditing(!editing)}
              className={editing ? primarySmall : smallButton}
            >
              {editing ? (
                t('tops.done')
              ) : (
                <>
                  <span className="md:hidden">{t('lists.edit')}</span>
                  <span className="hidden md:inline">
                    {t(tier ? 'tiers.editRows' : 'lists.edit')}
                  </span>
                </>
              )}
            </button>
          )}
        </span>
      </div>
      {editing && (
        <div className="anim-rise text-mid flex flex-wrap items-center gap-3 text-sm">
          <span>
            {t(tier ? 'tiers.hint' : list.ranked ? 'lists.editHint' : 'lists.editHintFree')}
          </span>
          {!tier && list.ranked && works.some((w) => w.entry.rating != null) && (
            <button
              type="button"
              className="ml-auto underline decoration-white/30 underline-offset-4 hover:text-white"
              onClick={() => {
                if (!window.confirm(t('lists.byRatingConfirm'))) return;
                reorder(
                  [...works]
                    .sort((a, b) => (b.entry.rating ?? -1) - (a.entry.rating ?? -1))
                    .map((w) => w.entry.id),
                );
              }}
            >
              {t('lists.byRating')}
            </button>
          )}
        </div>
      )}
      {!works.length && !tier && (
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
      {tier ? (
        <TierBoard
          works={works}
          tiers={list.tiers}
          editing={editing}
          onSave={saveTiers}
          onRemove={remove}
          onTiers={saveRows}
        />
      ) : editing ? (
        <SortableList ids={ids} onReorder={reorder} grid={list.layout === 'grid'}>
          {list.layout === 'grid' ? (
            <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] xl:grid-cols-8">
              {works.map((w, i) => (
                <SortablePoster
                  key={w.entry.id}
                  work={w}
                  index={list.ranked ? i : null}
                  onRemove={remove}
                />
              ))}
            </div>
          ) : (
            <div className="anim-rise flex flex-col gap-1">
              {works.map((w, i) => (
                <SortableRow
                  key={w.entry.id}
                  work={w}
                  index={i}
                  ranked={list.ranked}
                  count={works.length}
                  onPlace={(place) => {
                    const next = ids.filter((x) => x !== w.entry.id);
                    next.splice(Math.max(0, Math.min(place - 1, next.length)), 0, w.entry.id);
                    reorder(next);
                  }}
                  onNote={(note) => setNote(w.entry.id, note)}
                  onRemove={() => remove(w.entry.id)}
                />
              ))}
            </div>
          )}
        </SortableList>
      ) : list.layout === 'grid' ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] xl:grid-cols-8">
          {works.map((w, i) => (
            <article key={w.entry.id} className="flex min-w-0 flex-col gap-1">
              {list.ranked && <Rank n={i + 1} />}
              <PosterCard media={{ ...w.entry.media, mine: libraryMark(w.entry) }} />
            </article>
          ))}
        </div>
      ) : (
        <ol className="anim-rise flex flex-col gap-1">
          {works.map((w, i) => (
            <li
              key={w.entry.id}
              className="flex min-w-0 items-center rounded-2xl px-2 py-2 transition-colors hover:bg-white/[0.04]"
            >
              <MediaLink
                media={w.entry.media}
                className="flex min-w-0 flex-1 items-center gap-3 md:gap-4"
              >
                {list.ranked && (
                  <span className="font-display w-8 shrink-0 text-right text-2xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums md:w-10 md:text-3xl">
                    {n(i + 1)}
                  </span>
                )}
                <Cover
                  src={w.entry.coverUrl ?? w.entry.media.coverUrl}
                  fallbacks={w.entry.coverFallbacks}
                  className="w-12 shrink-0"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{w.entry.title}</span>
                  {w.item.note && (
                    <span className="text-mid truncate font-serif text-[15px] italic">
                      {w.item.note}
                    </span>
                  )}
                </span>
                <Score rating={w.entry.rating} />
              </MediaLink>
            </li>
          ))}
        </ol>
      )}
      <AddWorks
        open={adding}
        onClose={() => setAdding(false)}
        entries={entries.filter(
          (e) =>
            !e.partOf && !ids.includes(e.id) && (!list.kind || kindOfMedia(e.media) === list.kind),
        )}
        onAdd={async (work) => {
          const fresh = await write(list, { add: [work.id] });
          const now = fresh?.find((l) => l.id === list.id);
          if (now?.ranked && !tier && now.items.length > 1) {
            setAdding(false);
            setDuel(work);
          }
        }}
      />
      {settings && <ListSettings list={list} onClose={() => setSettings(false)} />}
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

function BackLink({ tier = false }: { tier?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      href={tier ? '/lists?tab=tiers' : '/lists'}
      className="text-mid -mb-2 inline-flex items-center gap-1.5 self-start text-sm hover:text-white"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t(tier ? 'lists.backTiers' : 'lists.back')}
    </Link>
  );
}

function Rank({ n: value }: { n: number }) {
  const { n } = useI18n();
  return (
    <span className="font-display text-mid text-2xl leading-none font-extrabold tracking-[-0.04em] tabular-nums">
      {n(value)}
    </span>
  );
}

function Score({ rating }: { rating: number | null | undefined }) {
  const { locale } = useI18n();
  if (rating == null) return null;
  return (
    <span className="flex min-w-[58px] shrink-0 items-center justify-center gap-1 rounded-full bg-star px-2.5 py-1 text-sm font-bold text-on-bright">
      <Star className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden />
      {formatRating(rating, locale)}
    </span>
  );
}

const SortableRow = memo(function SortableRow({
  work: w,
  index,
  ranked,
  count,
  onPlace,
  onNote,
  onRemove,
}: {
  work: Work;
  index: number;
  ranked: boolean;
  count: number;
  onPlace: (place: number) => void;
  onNote: (note: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { setNode, style, dragging, grab } = useSortableItem(w.entry.id);
  return (
    <div
      ref={setNode}
      style={style}
      {...grab}
      aria-label={t('lists.drag', { title: w.entry.title })}
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-xl py-1.5 pr-1 pl-2 transition-[background-color,box-shadow] select-none md:gap-3',
        dragging
          ? 'bg-panel-hi shadow-[0_12px_32px_rgba(0,0,0,0.5)] ring-1 ring-white/25'
          : 'hover:bg-white/[0.03]',
      )}
    >
      <GripVertical className="text-faint size-4 shrink-0" aria-hidden />
      {ranked && (
        <input
          key={`${w.entry.id}:${index}`}
          defaultValue={index + 1}
          inputMode="numeric"
          aria-label={t('lists.place', { title: w.entry.title })}
          {...fieldInDraggable}
          onBlur={(e) => {
            const place = Number(e.currentTarget.value);
            if (Number.isInteger(place) && place >= 1 && place <= count && place !== index + 1)
              onPlace(place);
            else e.currentTarget.value = String(index + 1);
          }}
          className="font-display w-10 shrink-0 rounded-lg bg-transparent py-1 text-center text-2xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums outline-none hover:bg-white/[0.06] focus:bg-white/[0.08]"
        />
      )}
      <Cover
        src={w.entry.coverUrl ?? w.entry.media.coverUrl}
        fallbacks={w.entry.coverFallbacks}
        className="w-11 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{w.entry.title}</span>
        <input
          defaultValue={w.item.note}
          maxLength={280}
          placeholder={t('lists.notePlaceholder')}
          aria-label={t('lists.note', { title: w.entry.title })}
          {...fieldInDraggable}
          onBlur={(e) => {
            const note = e.currentTarget.value.trim();
            if (note !== w.item.note) onNote(note);
          }}
          className="text-mid placeholder:text-faint w-full truncate bg-transparent font-serif text-[15px] italic outline-none"
        />
      </span>
      <Score rating={w.entry.rating} />
      <button
        type="button"
        {...buttonInDraggable}
        onClick={onRemove}
        aria-label={t('lists.remove', { title: w.entry.title })}
        className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
});

function SortablePoster({
  work: w,
  index,
  onRemove,
}: {
  work: Work;
  index: number | null;
  onRemove: (trackedId: number) => void;
}) {
  const { t } = useI18n();
  const { setNode, style, dragging, grab } = useSortableItem(w.entry.id);
  return (
    <article
      ref={setNode}
      style={style}
      {...grab}
      aria-label={t('lists.drag', { title: w.entry.title })}
      className={cx('relative flex min-w-0 flex-col gap-1 select-none', dragging && 'opacity-80')}
    >
      {index !== null && <Rank n={index + 1} />}
      <span className="block rounded-[6px]">
        <Cover
          src={w.entry.coverUrl ?? w.entry.media.coverUrl}
          fallbacks={w.entry.coverFallbacks}
        />
      </span>
      <span className="truncate text-sm">{w.entry.title}</span>
      <button
        type="button"
        {...buttonInDraggable}
        onClick={() => onRemove(w.entry.id)}
        aria-label={t('lists.remove', { title: w.entry.title })}
        className="bg-bg/85 absolute right-1 bottom-8 flex size-8 items-center justify-center rounded-full"
      >
        <X className="size-4" aria-hidden />
      </button>
    </article>
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
  ).slice(0, 60);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="ui-panel anim-dialog bg-bg border-line fixed inset-x-3 top-[8vh] z-50 mx-auto flex h-[min(640px,84vh)] max-w-[520px] flex-col overflow-hidden rounded-3xl border outline-none">
          <div className="flex shrink-0 flex-col gap-3 p-5 pb-3">
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Dialog.Title className="font-display text-[22px] leading-tight font-extrabold tracking-[-0.03em]">
                  {t('lists.addWorks')}
                </Dialog.Title>
                <Dialog.Description className="text-muted text-[13px]">
                  {t('lists.addWorksHint')}
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label={t('common.close')}
                className="text-mid -mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
              >
                <X className="size-5" aria-hidden />
              </Dialog.Close>
            </div>
            <label className="relative block">
              <Search
                className="text-faint pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
                aria-hidden
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('tops.addPlaceholder')}
                aria-label={t('lists.addWorks')}
                autoFocus
                className={cx(field, 'pl-10')}
              />
            </label>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pb-3">
            {found.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onAdd(e)}
                className="flex shrink-0 items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-white/[0.06]"
              >
                <Cover
                  src={e.coverUrl ?? e.media.coverUrl}
                  fallbacks={e.coverFallbacks}
                  className="w-9 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <Plus className="text-mid size-4 shrink-0" aria-hidden />
              </button>
            ))}
            {!found.length && <p className="text-muted px-2 py-4 text-sm">{t('lists.noMatch')}</p>}
          </div>
          <div className="border-line flex shrink-0 justify-end border-t px-5 py-3">
            <button type="button" className={primarySmall} onClick={onClose}>
              {t('tops.done')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ListSettings({ list, onClose }: { list: WorkList; onClose: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const write = useListWrite();
  const tier = isTierList(list);
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description);
  const [ranked, setRanked] = useState(list.ranked);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="ui-panel anim-dialog bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[440px] -translate-y-1/2 flex-col gap-3 rounded-3xl border p-6 outline-none">
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
          {!tier && (
            <Select
              label={t('lists.order')}
              value={ranked ? 'ranked' : 'free'}
              onChange={(v) => setRanked(v === 'ranked')}
              options={[
                { value: 'ranked', label: t('lists.ranked') },
                { value: 'free', label: t('lists.unranked') },
              ]}
            />
          )}
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="text-bad mr-auto text-[13px] hover:underline"
              onClick={async () => {
                if (!window.confirm(t('lists.deleteConfirm', { name: list.name }))) return;
                try {
                  await mutate(
                    '/api/lists',
                    await send<WorkList[]>(`/api/lists/${list.id}`, 'DELETE'),
                    { revalidate: false },
                  );
                  router.push(tier ? '/lists?tab=tiers' : '/lists');
                } catch (e) {
                  toast({ tone: 'bad', text: errorText(t, e) });
                }
              }}
            >
              {t('tops.delete')}
            </button>
            <button type="button" className={smallButton} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!name.trim()}
              className={primarySmall}
              onClick={async () => {
                await write(list, {
                  name: name.trim(),
                  description: description.trim(),
                  ...(tier ? {} : { ranked }),
                });
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
