'use client';
import { useLook } from '@/lib/client/theme';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Check, ListPlus, Plus } from 'lucide-react';
import type { DiscoverKind, TrackedMedia, UnifiedMedia, WorkList } from '@/types/shared';
import { KIND_IDS, inKindScope, type Kind, type KindScope } from '@/domain/kinds';
import { useUniverse } from '@/lib/client/universe';
import { DEFAULT_TIERS, tierOfRating } from '@/domain/tiers';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Duel } from './duel';
import { Select } from './select';
import { toast } from './notify';
import { Cover, cx, errorText, field, primarySmall, smallButton } from './ui';

type T = (key: string, vars?: Record<string, string | number>) => string;

export const useLists = () => useApi<WorkList[]>('/api/lists');

export const listName = (t: T, list: Pick<WorkList, 'name' | 'system'>) =>
  list.system === 'favorites' ? t('favorites.title') : list.name;

/** The list's works the library shows (works hidden from this account are left out). */
export function listWorks(list: WorkList, entries: TrackedMedia[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return list.items.flatMap((i) => {
    const entry = byId.get(i.trackedId);
    return entry ? [{ item: i, entry }] : [];
  });
}

/** Patches one list and keeps every view of the lists (and the likes) in step. */
export function useListWrite() {
  const { mutate } = useSWRConfig();
  const { t } = useI18n();
  return async (list: Pick<WorkList, 'id' | 'system'>, patch: Record<string, unknown>) => {
    try {
      const fresh = await send<WorkList[]>(`/api/lists/${list.id}`, 'PATCH', patch);
      await mutate('/api/lists', fresh, { revalidate: false });
      if (list.system === 'favorites') await mutate('/api/tracked');
      return fresh;
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
      await mutate('/api/lists');
      return null;
    }
  };
}

/**
 * Whether a list belongs to the type on screen: a list made for a kind belongs to that kind; any
 * other list to every kind its works have (a list of manga and anime shows under both). An empty
 * list shows everywhere; a list whose works are all hidden by the 18+ mode shows nowhere.
 */
export function listInUniverse(
  list: WorkList,
  entries: TrackedMedia[],
  view: DiscoverKind | KindScope,
) {
  const scope: KindScope = typeof view === 'string' ? { kind: view } : view;
  if (list.system) return true;
  if (list.kind) {
    if (scope.kind === 'all') return true;
    if (list.kind !== scope.kind) return false;
    // Made for one section of the extension kind: under that section (or every section).
    return !list.section || !scope.section || list.section === scope.section;
  }
  const works = listWorks(list, entries);
  if (!works.length) return list.hidden === 0;
  return (
    scope.kind === 'all' ||
    works.some((w) => inKindScope(w.entry.media, { ...scope, enabled: null }))
  );
}

export const isTierList = (list: Pick<WorkList, 'layout'>) => list.layout === 'tiers';

export function listMeta(
  t: T,
  n: (v: number) => string,
  list: WorkList,
  count: number,
  sectionName?: (id: string) => string | undefined,
) {
  return [
    t('lists.count', { count: n(count) }),
    isTierList(list) ? t('lists.tierList') : list.ranked ? t('lists.ranked') : t('lists.unranked'),
    list.section
      ? (sectionName?.(list.section) ?? t(`kind.${list.kind}`))
      : list.kind
        ? t(`kind.${list.kind}`)
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ListCard({ list, entries }: { list: WorkList; entries: TrackedMedia[] }) {
  const { t, n } = useI18n();
  const look = useLook();
  const works = listWorks(list, entries);
  const universe = useUniverse();
  const sectionName = (id: string) => universe.allSections.find((s) => s.id === id)?.name;
  const cover = (i: number, className?: string) => {
    const w = works[i]?.entry;
    return w ? (
      <Cover
        key={w.id}
        src={w.coverUrl ?? w.media.coverUrl}
        fallbacks={w.coverFallbacks}
        className={className}
      />
    ) : (
      <span key={i} className={cx('aspect-[2/3] bg-white/[0.05]', className)} />
    );
  };
  const name = <span className="truncate font-semibold">{listName(t, list)}</span>;
  const meta = (
    <span className="text-muted -mt-1.5 truncate text-[13px]">
      {listMeta(t, n, list, works.length, sectionName)}
    </span>
  );
  if (look === 'cine')
    // Ciné: the first posters fanned out like a hand of cards.
    return (
      <Link href={`/lists/${list.id}`} className="group flex min-w-0 flex-col gap-3">
        <span className="relative block aspect-[16/11]">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="absolute top-[4%] w-[44%] transition-transform duration-300 group-hover:-translate-y-1"
              style={{
                left: `${i * 18}%`,
                transform: `rotate(${i * 3 - 4}deg)`,
                zIndex: i,
              }}
            >
              {cover(i, 'shadow-[-10px_10px_30px_rgba(0,0,0,0.55)]')}
            </span>
          ))}
        </span>
        <span className="truncate text-[18px] font-bold">{listName(t, list)}</span>
        {meta}
      </Link>
    );
  return (
    <Link href={`/lists/${list.id}`} className="group flex min-w-0 flex-col gap-2.5">
      <span className="grid grid-cols-4 gap-[3px] overflow-hidden rounded-xl bg-white/[0.04] transition-opacity group-hover:opacity-90">
        {[0, 1, 2, 3].map((i) => cover(i, '!rounded-none'))}
      </span>
      {name}
      {meta}
    </Link>
  );
}

export function ListsGrid({ lists, entries }: { lists: WorkList[]; entries: TrackedMedia[] }) {
  const look = useLook();
  return (
    <div
      className={cx(
        look === 'cine'
          ? 'grid gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'
          : 'grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
      )}
    >
      {lists.map((list) => (
        <ListCard key={list.id} list={list} entries={entries} />
      ))}
    </div>
  );
}

export function NewListDialog({
  open,
  onClose,
  onCreated,
  add,
  tier = false,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (list: WorkList) => void;
  /** Works the new list starts with. */
  add?: number[];
  /** A tier list (S to D) rather than a list. */
  tier?: boolean;
}) {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const library = useApi<TrackedMedia[]>(tier ? '/api/tracked' : null);
  const [name, setName] = useState('');
  // A kind, or one section of the extension kind (`extension:<section>`).
  const [choice, setChoice] = useState('');
  const [kind, section] = choice.startsWith('extension:')
    ? (['extension', choice.slice('extension:'.length)] as const)
    : ([choice as Kind | '', null] as const);
  const universe = useUniverse();
  const [ranked, setRanked] = useState(true);
  const [fill, setFill] = useState<'rated' | 'all' | 'none'>('rated');
  const [place, setPlace] = useState(true);
  const [busy, setBusy] = useState(false);
  // A tier list starts from the library: its rated works (or all) of the kind chosen.
  const from = (library.data ?? []).filter(
    (e) =>
      !e.partOf &&
      (!kind || inKindScope(e.media, { kind, section })) &&
      (fill === 'all' || (fill === 'rated' && e.rating != null)),
  );
  const start = tier ? (fill === 'none' ? [] : from.slice(0, 500)) : (add ?? []);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="ui-panel anim-dialog bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[440px] -translate-y-1/2 flex-col gap-4 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] leading-none font-extrabold tracking-[-0.03em]">
            {t(tier ? 'lists.newTier' : 'lists.new')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t(tier ? 'lists.newTierHint' : 'lists.newHint')}
          </Dialog.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setBusy(true);
              try {
                const { id, lists } = await send<{ id: number; lists: WorkList[] }>(
                  '/api/lists',
                  'POST',
                  {
                    name: name.trim(),
                    kind: kind || null,
                    ...(section ? { section } : {}),
                    ranked: tier ? false : ranked,
                    ...(tier ? { layout: 'tiers' } : {}),
                    add: start.length
                      ? start.map((w) => (typeof w === 'number' ? w : w.id))
                      : undefined,
                  },
                );
                let fresh = lists;
                const placed =
                  tier && place
                    ? from.flatMap((w) => {
                        const tierOf = tierOfRating(w.rating, DEFAULT_TIERS);
                        return tierOf ? [{ trackedId: w.id, tier: tierOf }] : [];
                      })
                    : [];
                if (placed.length)
                  fresh = await send<WorkList[]>(`/api/lists/${id}`, 'PATCH', { items: placed });
                await mutate('/api/lists', fresh, { revalidate: false });
                setName('');
                const created = fresh.find((l) => l.id === id);
                if (created) onCreated?.(created);
                onClose();
              } catch (error) {
                toast({ tone: 'bad', text: errorText(t, error) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(tier ? 'lists.tierPlaceholder' : 'lists.namePlaceholder')}
              aria-label={t('lists.name')}
              maxLength={80}
              autoFocus
              className={field}
            />
            <div className="grid grid-cols-2 gap-2">
              {tier ? (
                <Select
                  label={t('lists.fill')}
                  value={fill}
                  onChange={(v) => setFill(v as typeof fill)}
                  options={(['rated', 'all', 'none'] as const).map((f) => ({
                    value: f,
                    label: t(`lists.fill.${f}`),
                  }))}
                />
              ) : (
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
              <Select
                label={t('catalog.kind')}
                value={choice}
                onChange={setChoice}
                options={[
                  { value: '', label: t('kind.all') },
                  // The extension kind: every section, or one (named by its extension).
                  ...KIND_IDS.flatMap((k) => [
                    { value: k, label: t(`kind.${k}`) },
                    ...(k === 'extension'
                      ? universe.sections.map((s) => ({
                          value: `extension:${s.id}`,
                          label: s.name,
                        }))
                      : []),
                  ]),
                ]}
              />
            </div>
            {tier && fill !== 'none' && (
              <label className="text-mid flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={place}
                  onChange={(e) => setPlace(e.target.checked)}
                  className="size-4 accent-white"
                />
                {t('lists.placeOnCreate', { count: String(from.length) })}
              </label>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={smallButton} onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || !name.trim()} className={primarySmall}>
                {t('lists.create')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Follows a catalog work (to watch/read, nothing downloaded) so it can join lists. */
async function ensureTracked(media: UnifiedMedia, entry: TrackedMedia | undefined) {
  return (
    entry ??
    (await send<TrackedMedia>('/api/tracked', 'POST', {
      media,
      status: 'PLANNING',
      autoDownload: false,
    }))
  );
}

/**
 * A work's sheet: which lists hold it (and where), ticked in one place; a new list from here.
 * Ticking a ranked list that already has works offers to place it by duels.
 */
export function ListsButton({ media, entry }: { media: UnifiedMedia; entry?: TrackedMedia }) {
  const { t, n } = useI18n();
  const { mutate } = useSWRConfig();
  const lists = useLists();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const write = useListWrite();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [duel, setDuel] = useState<{ list: WorkList; work: TrackedMedia } | null>(null);
  const holding = useMemo(
    () => (lists.data ?? []).filter((l) => entry && l.items.some((i) => i.trackedId === entry.id)),
    [lists.data, entry],
  );
  const toggle = async (list: WorkList) => {
    setBusy(list.id);
    try {
      const inside = entry && list.items.some((i) => i.trackedId === entry.id);
      if (inside) {
        await write(list, { remove: [entry.id] });
        return;
      }
      const work = await ensureTracked(media, entry);
      if (!entry) await mutate('/api/tracked');
      const fresh = await write(list, { add: [work.id] });
      const now = fresh?.find((l) => l.id === list.id);
      if (now?.ranked && !isTierList(now) && now.items.length > 1) setDuel({ list: now, work });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  };
  const entries = library.data ?? [];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('lists.button')}
        title={t('lists.button')}
        className="text-fg inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 text-sm hover:bg-white/15"
      >
        <ListPlus className="size-[18px]" aria-hidden />
        <span>
          {t('lists.button')}
          {holding.length > 0 && <span className="text-mid"> · {n(holding.length)}</span>}
        </span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="ui-panel anim-dialog border-line fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-50 flex max-h-[80vh] flex-col gap-1 overflow-y-auto rounded-3xl border bg-panel p-4 outline-none md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:w-[400px] md:-translate-x-1/2 md:-translate-y-1/2">
            <Dialog.Title className="px-2 pt-1 pb-2 font-semibold">{t('lists.addTo')}</Dialog.Title>
            <Dialog.Description className="sr-only">{t('lists.addToHint')}</Dialog.Description>
            {(lists.data ?? []).map((list) => {
              const at = entry ? list.items.findIndex((i) => i.trackedId === entry.id) : -1;
              const works = listWorks(list, entries).length;
              return (
                <button
                  key={list.id}
                  type="button"
                  role="checkbox"
                  aria-checked={at >= 0}
                  disabled={busy !== null}
                  onClick={() => void toggle(list)}
                  className="flex items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-white/[0.06] disabled:opacity-60"
                >
                  <span
                    aria-hidden
                    className={cx(
                      'flex size-5 shrink-0 items-center justify-center rounded-md border',
                      at >= 0 ? 'border-white bg-white text-black' : 'border-white/40',
                    )}
                  >
                    {at >= 0 && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{listName(t, list)}</span>
                  <span className="text-muted shrink-0 text-xs">
                    {at >= 0 && isTierList(list)
                      ? (list.tiers.find((x) => x.id === list.items[at].tier)?.label ??
                        t('lists.pool'))
                      : at >= 0 && list.ranked
                        ? t('lists.rank', { n: n(at + 1) })
                        : n(works)}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-mid border-line mt-1 flex items-center gap-3 border-t px-2 pt-3.5 pb-1.5 text-left text-sm hover:text-white"
            >
              <Plus className="size-5" aria-hidden />
              {t('lists.new')}
            </button>
            <p className="text-muted px-2 pt-1 text-xs">{t('lists.addToHint')}</p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <NewListDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (list) => {
          const work = await ensureTracked(media, entry).catch((e) => {
            toast({ tone: 'bad', text: errorText(t, e) });
            return null;
          });
          if (!work) return;
          if (!entry) await mutate('/api/tracked');
          await write(list, { add: [work.id] });
        }}
      />
      {duel && (
        <Duel
          title={listName(t, duel.list)}
          sorted={listWorks(duel.list, entries)
            .map((w) => w.entry)
            .filter((w) => w.id !== duel.work.id)}
          pending={[duel.work]}
          onCancel={() => setDuel(null)}
          onDone={(order) => {
            void write(duel.list, { order });
            setDuel(null);
          }}
        />
      )}
    </>
  );
}

/** Library selection: adds the selected works to one list (or a new one). */
export function AddToList({
  selected,
  className,
  disabled,
}: {
  selected: TrackedMedia[];
  className?: string;
  disabled?: boolean;
}) {
  const { t, n } = useI18n();
  const lists = useLists();
  const write = useListWrite();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Select
        label={t('lists.addTo')}
        value=""
        size="md"
        onChange={async (v) => {
          if (!v || !selected.length) return;
          if (v === 'new') return setCreating(true);
          const list = lists.data?.find((l) => l.id === Number(v));
          if (!list) return;
          if (await write(list, { add: selected.map((e) => e.id) }))
            toast({
              tone: 'ok',
              text: t('lists.added', { count: n(selected.length), name: listName(t, list) }),
            });
        }}
        options={[
          { value: '', label: t('lists.addTo') },
          ...(lists.data ?? []).map((l) => ({ value: String(l.id), label: listName(t, l) })),
          { value: 'new', label: `+ ${t('lists.new')}` },
        ]}
        className={cx(className, disabled && 'pointer-events-none opacity-40')}
      />
      <NewListDialog
        open={creating}
        onClose={() => setCreating(false)}
        add={selected.map((e) => e.id)}
        onCreated={(list) =>
          toast({
            tone: 'ok',
            text: t('lists.added', { count: n(selected.length), name: list.name }),
          })
        }
      />
    </>
  );
}
