'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { memo, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Settings2, X } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  rectIntersection,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ListTier, TierRow, TrackedMedia, WorkListItem } from '@/types/shared';
import { TIER_COLORS, newTierId } from '@/domain/tiers';
import { useI18n } from '@/i18n/I18nProvider';
import { useDragSensors } from './sortable';
import { Cover, cx, field, primarySmall, smallButton } from './ui';

/** The area of works not placed yet (no row can have this id: the API refuses it). */
const POOL = '__pool';
type Zones = Record<string, number[]>;

export interface TierWork {
  item: WorkListItem;
  entry: TrackedMedia;
}

function zonesOf(works: TierWork[], tiers: TierRow[]): Zones {
  const zones: Zones = Object.fromEntries([...tiers.map((t) => [t.id, []]), [POOL, []]]);
  for (const w of works) (zones[w.item.tier ?? POOL] ?? zones[POOL]).push(w.entry.id);
  return zones;
}

/** Inside a poster when there is one, else the row under the pointer. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const items = hits.filter((h) => typeof h.id === 'number');
  if (items.length) return items;
  return hits.length ? hits : rectIntersection(args);
};

/**
 * A tier list: its rows (its own: names, colors, order) and the works not placed yet. Posters
 * are dragged between rows and within a row (mouse, finger after a short press, keyboard); order
 * and rows are saved once, on drop. In the rows' edit mode, rows are added, renamed, recolored,
 * moved and removed (their works go back to "to place").
 */
export function TierBoard({
  works,
  tiers,
  editing,
  onSave,
  onRemove,
  onTiers,
}: {
  works: TierWork[];
  tiers: TierRow[];
  editing: boolean;
  onSave: (order: number[], changed: { trackedId: number; tier: ListTier | null }[]) => void;
  onRemove: (trackedId: number) => void;
  onTiers: (tiers: TierRow[]) => void;
}) {
  const { t, n } = useI18n();
  const sensors = useDragSensors();
  const initial = useMemo(() => zonesOf(works, tiers), [works, tiers]);
  const [draft, setDraft] = useState<Zones | null>(null);
  const latest = useRef<Zones | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [changing, setChanging] = useState<TierRow | 'new' | null>(null);
  const zones = draft ?? initial;
  const byId = useMemo(() => new Map(works.map((w) => [w.entry.id, w.entry])), [works]);
  const order = [...tiers.map((tier) => tier.id), POOL];
  const find = (z: Zones, id: UniqueIdentifier): string | undefined =>
    typeof id === 'string'
      ? id in z
        ? id
        : undefined
      : order.find((zone) => z[zone].includes(id));
  const update = (z: Zones) => {
    latest.current = z;
    setDraft(z);
  };

  const start = ({ active: a }: DragStartEvent) => {
    setActive(a.id as number);
    update({ ...initial });
  };
  const over = ({ active: a, over: o }: DragOverEvent) => {
    const z = latest.current;
    if (!z || !o) return;
    const from = find(z, a.id);
    const to = find(z, o.id);
    if (!from || !to || from === to) return;
    const target = [...z[to]];
    const at = target.indexOf(o.id as number);
    target.splice(at >= 0 ? at : target.length, 0, a.id as number);
    update({ ...z, [from]: z[from].filter((id) => id !== a.id), [to]: target });
  };
  const end = ({ active: a, over: o }: DragEndEvent) => {
    let z = latest.current;
    latest.current = null;
    setActive(null);
    if (z && o) {
      const zone = find(z, a.id);
      if (zone && zone === find(z, o.id) && a.id !== o.id) {
        const list = z[zone];
        const from = list.indexOf(a.id as number);
        const to = list.indexOf(o.id as number);
        if (from >= 0 && to >= 0) z = { ...z, [zone]: arrayMove(list, from, to) };
      }
      const next = order.flatMap((zone) => z![zone]);
      const was = new Map(order.flatMap((zone) => initial[zone].map((id) => [id, zone] as const)));
      const changed = order.flatMap((zone) =>
        z![zone]
          .filter((id) => was.get(id) !== zone)
          .map((id) => ({ trackedId: id, tier: zone === POOL ? null : zone })),
      );
      const before = order.flatMap((zone) => initial[zone]);
      if (changed.length || next.some((id, i) => id !== before[i])) onSave(next, changed);
    }
    setDraft(null);
  };
  const cancel = () => {
    latest.current = null;
    setActive(null);
    setDraft(null);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...tiers];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onTiers(next);
  };

  const dragged = active !== null ? byId.get(active) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={start}
      onDragOver={over}
      onDragEnd={end}
      onDragCancel={cancel}
    >
      <div className="flex flex-col gap-1 overflow-hidden rounded-2xl">
        {tiers.map((tier, i) => (
          <div
            key={tier.id}
            className="anim-rise grid grid-cols-[64px_minmax(0,1fr)] gap-1 md:grid-cols-[96px_minmax(0,1fr)]"
          >
            <button
              type="button"
              disabled={!editing}
              onClick={() => setChanging(tier)}
              aria-label={editing ? t('tiers.edit', { label: tier.label }) : tier.label}
              className="font-display flex min-h-[94px] items-center justify-center px-1 text-center text-xl leading-tight font-extrabold [overflow-wrap:anywhere] text-on-bright transition-[filter] enabled:hover:brightness-110 md:min-h-[112px] md:text-2xl"
              style={{ background: tier.color }}
            >
              {tier.label}
            </button>
            <div className="relative min-w-0">
              <TierZone id={tier.id} ids={zones[tier.id] ?? []} byId={byId} onRemove={onRemove} />
              {editing && (
                <span className="anim-rise absolute top-1.5 right-1.5 flex gap-1 rounded-full bg-black/55 p-1 backdrop-blur-md">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={t('tiers.up', { label: tier.label })}
                    className="flex size-8 items-center justify-center rounded-full text-white disabled:opacity-30"
                  >
                    <ArrowUp className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={i === tiers.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t('tiers.down', { label: tier.label })}
                    className="flex size-8 items-center justify-center rounded-full text-white disabled:opacity-30"
                  >
                    <ArrowDown className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setChanging(tier)}
                    aria-label={t('tiers.edit', { label: tier.label })}
                    className="flex size-8 items-center justify-center rounded-full text-white"
                  >
                    <Settings2 className="size-4" aria-hidden />
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <button
          type="button"
          onClick={() => setChanging('new')}
          disabled={tiers.length >= 20}
          className="anim-rise text-mid flex h-12 items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 text-sm transition-colors hover:border-white/40 hover:text-white disabled:opacity-40"
        >
          <Plus className="size-4" aria-hidden />
          {t('tiers.add')}
        </button>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-mid text-sm">
          {t('lists.pool')} · {n(zones[POOL].length)}
        </span>
        <TierZone id={POOL} ids={zones[POOL]} byId={byId} onRemove={onRemove} pool />
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }}>
        {dragged ? (
          <Cover
            src={dragged.coverUrl ?? dragged.media.coverUrl}
            fallbacks={dragged.coverFallbacks}
            className="w-[60px] scale-105 rotate-2 shadow-[0_16px_40px_rgba(0,0,0,0.6)] ring-2 ring-white md:w-[72px]"
          />
        ) : null}
      </DragOverlay>
      {changing && (
        <TierDialog
          tier={changing === 'new' ? null : changing}
          canDelete={tiers.length > 1}
          onClose={() => setChanging(null)}
          onSave={(row) => {
            onTiers(
              changing === 'new'
                ? [...tiers, { ...row, id: newTierId(tiers) }]
                : tiers.map((x) => (x.id === changing.id ? { ...x, ...row } : x)),
            );
            setChanging(null);
          }}
          onDelete={() => {
            if (changing !== 'new') onTiers(tiers.filter((x) => x.id !== changing.id));
            setChanging(null);
          }}
        />
      )}
    </DndContext>
  );
}

const TierZone = memo(function TierZone({
  id,
  ids,
  byId,
  onRemove,
  pool = false,
}: {
  id: string;
  ids: number[];
  byId: Map<number, TrackedMedia>;
  onRemove: (trackedId: number) => void;
  pool?: boolean;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <SortableContext id={id} items={ids} strategy={rectSortingStrategy}>
      <div
        ref={setNodeRef}
        className={cx(
          'flex h-full min-h-[94px] flex-wrap content-start gap-1.5 p-1.5 transition-colors duration-150 md:min-h-[112px]',
          pool ? 'rounded-2xl border border-dashed border-white/15' : '',
          isOver ? 'bg-white/[0.09]' : 'bg-white/[0.035]',
        )}
      >
        {ids.map((workId) => {
          const work = byId.get(workId);
          return work ? <Poster key={workId} work={work} onRemove={onRemove} /> : null;
        })}
        {pool && !ids.length && (
          <span className="text-muted self-center px-3 text-sm">{t('lists.poolEmpty')}</span>
        )}
      </div>
    </SortableContext>
  );
});

const Poster = memo(function Poster({
  work,
  onRemove,
}: {
  work: TrackedMedia;
  onRemove: (trackedId: number) => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: work.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        touchAction: 'manipulation',
      }}
      className={cx(
        'group relative w-[60px] cursor-grab transition-[opacity,scale] duration-150 select-none hover:scale-[1.04] active:cursor-grabbing md:w-[72px]',
        isDragging && 'opacity-25',
      )}
      title={work.title}
      aria-label={work.title}
      {...attributes}
      {...listeners}
    >
      <Cover src={work.coverUrl ?? work.media.coverUrl} fallbacks={work.coverFallbacks} />
      <button
        type="button"
        aria-label={t('lists.remove', { title: work.title })}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={() => onRemove(work.id)}
        className="bg-bg/85 absolute top-0.5 right-0.5 flex size-6 items-center justify-center rounded-full text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
});

function TierDialog({
  tier,
  canDelete,
  onClose,
  onSave,
  onDelete,
}: {
  tier: TierRow | null;
  canDelete: boolean;
  onClose: () => void;
  onSave: (row: { label: string; color: string }) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(tier?.label ?? '');
  const [color, setColor] = useState<string>(tier?.color ?? TIER_COLORS[3]);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="ui-panel anim-dialog bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[400px] -translate-y-1/2 flex-col gap-4 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] font-extrabold tracking-[-0.03em]">
            {t(tier ? 'tiers.editTitle' : 'tiers.add')}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{t('tiers.hint')}</Dialog.Description>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (label.trim()) onSave({ label: label.trim(), color });
            }}
          >
            <div className="flex items-center gap-3">
              <span
                className="font-display flex size-12 shrink-0 items-center justify-center rounded-xl text-lg font-extrabold text-on-bright"
                style={{ background: color }}
                aria-hidden
              >
                {label.trim().slice(0, 3) || '?'}
              </span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={24}
                autoFocus
                placeholder={t('tiers.labelPlaceholder')}
                aria-label={t('tiers.label')}
                className={field}
              />
            </div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('tiers.color')}>
              {TIER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === color}
                  aria-label={c}
                  onClick={() => setColor(c)}
                  className={cx(
                    'size-8 rounded-full transition-transform hover:scale-110',
                    c === color && 'ring-2 ring-white ring-offset-2 ring-offset-bg',
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2">
              {tier && canDelete && (
                <button
                  type="button"
                  className="text-bad mr-auto text-[13px] hover:underline"
                  onClick={onDelete}
                >
                  {t('tiers.delete')}
                </button>
              )}
              <button
                type="button"
                className={cx(smallButton, (!tier || !canDelete) && 'ml-auto')}
                onClick={onClose}
              >
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={!label.trim()} className={primarySmall}>
                {t(tier ? 'common.save' : 'tiers.create')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
