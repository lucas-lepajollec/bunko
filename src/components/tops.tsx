'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { memo, useMemo, useState } from 'react';
import { GripVertical, Plus, Star } from 'lucide-react';
import type { Ranking, TrackedMedia } from '@/types/shared';
import { KIND_IDS, type Kind } from '@/domain/kinds';
import { formatRating } from '@/domain/library-mark';
import { rankedKinds, rankingWorks, type RankedWork } from '@/domain/rankings';
import { send, useApi } from '@/lib/client/api';
import { useViewState } from '@/lib/client/view-state';
import { useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Duel } from './duel';
import { MediaLink } from './media-link';
import { Select } from './select';
import { SortableList, useSortableItem } from './sortable';
import { toast } from './notify';
import {
  Cover,
  Empty,
  SectionHeading,
  cx,
  errorText,
  field,
  primarySmall,
  smallButton,
} from './ui';

const SHOWN = 10;
type View = Pick<Ranking, 'kind' | 'order' | 'size'> & {
  key: string;
  id: number | null;
  name: string | null;
  builtin: Kind | null;
};

/**
 * Rankings by rating on the profile: one per kind, plus the user's own (a kind or every kind, top
 * N). A better score is always above. In the edit mode, works with the same score are grouped and
 * can be put in the user's order, by dragging them or by duels.
 */
export function Tops({ entries }: { entries: TrackedMedia[] }) {
  const { t, n } = useI18n();
  const universe = useUniverse();
  const rankings = useApi<Ranking[]>('/api/rankings');
  const saved = useMemo(() => rankings.data ?? [], [rankings.data]);
  const views: View[] = useMemo(() => {
    const builtins = rankedKinds(entries, universe.order).map((k) => {
      const row = saved.find((r) => r.builtin && r.kind === k);
      return {
        key: `kind:${k}`,
        id: row?.id ?? null,
        name: null,
        builtin: k,
        kind: k,
        size: null,
        order: row?.order ?? [],
      };
    });
    const own = saved
      .filter((r) => !r.builtin)
      .map((r) => ({ ...r, key: `own:${r.id}`, builtin: null }));
    return [...builtins, ...own];
  }, [entries, saved, universe.order]);
  const [chosen, setChosen] = useViewState<string>('top', '');
  // Opens on the kind with the most rated works.
  // Each ranking is sorted once per change of the library or the rankings, not per render.
  const counts = useMemo(
    () => new Map(views.map((v) => [v.key, rankingWorks(v, entries).length])),
    [views, entries],
  );
  const largest = [...views]
    .filter((v) => v.builtin)
    .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0))[0];
  const view = views.find((v) => v.key === chosen) ?? largest ?? views[0];
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [duel, setDuel] = useState<RankedWork[] | null>(null);
  const works = useMemo(() => (view ? rankingWorks(view, entries) : []), [view, entries]);
  const ids = works.map((w) => w.entry.id);
  const title = (v: View) =>
    v.builtin ? t('tops.kindTitle', { kind: t(`kind.${v.builtin}`) }) : (v.name ?? '');
  // Works by score, best first: only a group of equal scores can be reordered.
  const groups: RankedWork[][] = [];
  for (const w of works) {
    const last = groups.at(-1);
    if (last && last[0].entry.rating === w.entry.rating) last.push(w);
    else groups.push([w]);
  }
  const tied = groups.some((g) => g.length > 1);

  async function save(next: number[]) {
    if (!view) return;
    // Shown at once; the server keeps it.
    void rankings.mutate(
      (list) => {
        const rows = list ?? [];
        if (view.builtin && !view.id)
          return [
            ...rows,
            {
              id: -1,
              name: null,
              kind: view.builtin,
              mode: 'auto',
              size: null,
              order: next,
              builtin: true,
            },
          ];
        return rows.map((r) => (r.id === view.id ? { ...r, order: next } : r));
      },
      { revalidate: false },
    );
    try {
      const fresh = await send<Ranking[]>(
        '/api/rankings',
        'PATCH',
        view.builtin ? { builtin: view.builtin, order: next } : { id: view.id, order: next },
      );
      void rankings.mutate(fresh, { revalidate: false });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
      void rankings.mutate();
    }
  }
  /** The whole order with one group of equal scores in a new order. */
  const withGroup = (group: number[]) => {
    const first = ids.indexOf(group[0]) >= 0 ? Math.min(...group.map((id) => ids.indexOf(id))) : 0;
    const next = ids.filter((id) => !group.includes(id));
    next.splice(first, 0, ...group);
    return next;
  };
  const shown = all ? works : works.slice(0, SHOWN);

  return (
    <section id="tops" className="flex scroll-mt-28 flex-col gap-5">
      <SectionHeading title={t('tops.title')} aside={t('tops.aside')} />
      <div className="no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto px-4 py-0.5 text-sm md:mx-0 md:flex-wrap md:px-0">
        {views.map((v) => (
          <button
            key={v.key}
            type="button"
            aria-pressed={view?.key === v.key}
            onClick={() => {
              setChosen(v.key);
              setAll(false);
              setEditing(false);
            }}
            className={cx(
              'h-[34px] shrink-0 rounded-full px-3.5',
              view?.key === v.key ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
            )}
          >
            {title(v)}
            <span className="text-muted ml-1.5 font-serif italic">{n(counts.get(v.key) ?? 0)}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="text-mid flex h-[34px] shrink-0 items-center gap-1.5 rounded-full border border-white/15 px-3.5 hover:text-white"
        >
          <Plus className="size-4" aria-hidden />
          {t('tops.new')}
        </button>
      </div>
      {!view ? (
        <Empty title={t('tops.empty')}>{t('tops.emptyBody')}</Empty>
      ) : (
        <>
          <div className="text-mid flex flex-wrap items-center gap-2 text-sm">
            <span>
              {editing ? t('tops.tieHint') : t('tops.autoHint')}
              {!editing && view.size ? ` · ${t('tops.topN', { n: n(view.size) })}` : ''}
            </span>
            <span className="ml-auto flex gap-2">
              {editing && !view.builtin && view.id && (
                <button
                  type="button"
                  className={cx(smallButton, 'text-bad')}
                  onClick={async () => {
                    if (!window.confirm(t('tops.deleteConfirm', { name: title(view) }))) return;
                    try {
                      await rankings.mutate(
                        await send<Ranking[]>('/api/rankings', 'DELETE', { id: view.id }),
                        { revalidate: false },
                      );
                      setChosen('');
                      setEditing(false);
                    } catch (e) {
                      toast({ tone: 'bad', text: errorText(t, e) });
                    }
                  }}
                >
                  {t('tops.delete')}
                </button>
              )}
              {(tied || (!view.builtin && view.id)) && (
                <button
                  type="button"
                  aria-pressed={editing}
                  onClick={() => setEditing(!editing)}
                  className={editing ? primarySmall : smallButton}
                >
                  {editing ? t('tops.done') : t('tops.edit')}
                </button>
              )}
            </span>
          </div>
          {editing ? (
            <div className="anim-rise flex max-h-[min(72vh,760px)] flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
              {groups.map((group) =>
                group.length === 1 ? (
                  <RankRow key={group[0].entry.id} work={group[0]} />
                ) : (
                  <div
                    key={group[0].entry.id}
                    className="my-1 flex flex-col gap-1 rounded-2xl bg-white/[0.04] p-1.5"
                  >
                    <div className="flex items-center gap-2 px-2 pt-1 text-sm">
                      <Score rating={group[0].entry.rating!} small />
                      <span className="text-mid">
                        {t('tops.tieBreak', { count: n(group.length) })}
                      </span>
                      <button
                        type="button"
                        className="text-mid ml-auto rounded-full px-3 py-1 text-[13px] hover:bg-white/[0.08] hover:text-white"
                        onClick={() => setDuel(group)}
                      >
                        {t('tops.duel')}
                      </button>
                    </div>
                    <SortableList
                      ids={group.map((w) => w.entry.id)}
                      onReorder={(next) => void save(withGroup(next))}
                    >
                      {group.map((w) => (
                        <SortableRankRow key={w.entry.id} work={w} />
                      ))}
                    </SortableList>
                  </div>
                ),
              )}
            </div>
          ) : (
            <ol
              className={cx(
                'anim-rise flex flex-col gap-1',
                all && 'max-h-[min(72vh,760px)] overflow-y-auto overscroll-contain pr-1',
              )}
            >
              {shown.map((w) => (
                <RankRow key={w.entry.id} work={w} as="li" />
              ))}
            </ol>
          )}
          {!editing && works.length > SHOWN && (
            <button
              type="button"
              className={cx(smallButton, 'self-start')}
              onClick={() => setAll(!all)}
            >
              {all ? t('tops.less') : t('tops.all', { count: n(works.length) })}
            </button>
          )}
        </>
      )}
      {duel && view && (
        <Duel
          title={title(view)}
          sorted={[duel[0].entry]}
          pending={duel.slice(1).map((w) => w.entry)}
          onCancel={() => setDuel(null)}
          onDone={(groupOrder) => {
            void save(withGroup(groupOrder));
            setDuel(null);
          }}
        />
      )}
      <CreateRanking
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await rankings.mutate();
          setChosen(`own:${id}`);
        }}
      />
    </section>
  );
}

function Score({ rating, small }: { rating: number; small?: boolean }) {
  const { locale } = useI18n();
  return (
    <span
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-full bg-[#f5c518] font-bold text-black',
        small ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
      )}
    >
      <Star
        className={small ? 'size-3' : 'size-3.5'}
        fill="currentColor"
        strokeWidth={0}
        aria-hidden
      />
      {formatRating(rating, locale)}
    </span>
  );
}

function RankBody({ work: w, link = true }: { work: RankedWork; link?: boolean }) {
  const { n } = useI18n();
  const body = (
    <>
      <span className="font-display w-8 shrink-0 text-right text-2xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums md:w-10 md:text-3xl">
        {n(w.rank)}
      </span>
      <Cover
        src={w.entry.coverUrl ?? w.entry.media.coverUrl}
        fallbacks={w.entry.coverFallbacks}
        className="w-12 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{w.entry.title}</span>
      <Score rating={w.entry.rating!} />
    </>
  );
  const row = 'flex min-w-0 flex-1 items-center gap-3 md:gap-4';
  return link ? (
    <MediaLink media={w.entry.media} className={row}>
      {body}
    </MediaLink>
  ) : (
    <span className={row}>{body}</span>
  );
}

const RankRow = memo(function RankRow({
  work,
  as: Tag = 'div',
}: {
  work: RankedWork;
  as?: 'li' | 'div';
}) {
  return (
    <Tag className="flex min-w-0 items-center rounded-2xl px-2 py-2 transition-colors hover:bg-white/[0.04]">
      <RankBody work={work} />
    </Tag>
  );
});

/** A row of equal scores in the edit mode: the whole row is grabbed. */
const SortableRankRow = memo(function SortableRankRow({ work }: { work: RankedWork }) {
  const { t } = useI18n();
  const { setNode, style, dragging, grab } = useSortableItem(work.entry.id);
  return (
    <div
      ref={setNode}
      style={style}
      {...grab}
      aria-label={t('lists.drag', { title: work.entry.title })}
      className={cx(
        'flex min-w-0 items-center gap-1 rounded-xl py-1.5 pr-2 pl-1 transition-[background-color,box-shadow] select-none',
        dragging
          ? 'bg-[#22201d] shadow-[0_12px_32px_rgba(0,0,0,0.5)] ring-1 ring-white/25'
          : 'hover:bg-white/[0.04]',
      )}
    >
      <GripVertical className="text-faint size-4 shrink-0" aria-hidden />
      <RankBody work={work} link={false} />
    </div>
  );
});

function CreateRanking({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { t, n } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="anim-dialog bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[440px] -translate-y-1/2 flex-col gap-4 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] leading-none font-extrabold tracking-[-0.03em]">
            {t('tops.new')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t('tops.newHint')}
          </Dialog.Description>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tops.namePlaceholder')}
            aria-label={t('tops.name')}
            maxLength={80}
            className={field}
          />
          <div className="grid grid-cols-2 gap-2">
            <Select
              label={t('catalog.kind')}
              value={kind}
              onChange={(v) => setKind(v as Kind | '')}
              options={[
                { value: '', label: t('kind.all') },
                ...KIND_IDS.map((k) => ({ value: k, label: t(`kind.${k}`) })),
              ]}
            />
            <Select
              label={t('tops.size')}
              value={size}
              onChange={setSize}
              options={[
                { value: '', label: t('tops.sizeAll') },
                ...[10, 25, 50, 100].map((x) => ({
                  value: String(x),
                  label: t('tops.topN', { n: n(x) }),
                })),
              ]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className={smallButton} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={busy || !name.trim()}
              className={primarySmall}
              onClick={async () => {
                setBusy(true);
                try {
                  const { id } = await send<{ id: number }>('/api/rankings', 'POST', {
                    name: name.trim(),
                    kind: kind || null,
                    size: size ? Number(size) : null,
                  });
                  setName('');
                  onCreated(id);
                } catch (e) {
                  toast({ tone: 'bad', text: errorText(t, e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('tops.create')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
