'use client';
import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
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
import type { ListTier, TrackedMedia, WorkListItem } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { useDragSensors } from './sortable';
import { Cover, cx } from './ui';

type Zone = ListTier | 'pool';
type Zones = Record<Zone, number[]>;
const TIERS: ListTier[] = ['S', 'A', 'B', 'C', 'D'];
const ZONES: Zone[] = [...TIERS, 'pool'];
/** The usual tier colors, light enough for dark letters. */
const COLORS: Record<ListTier, string> = {
  S: '#ff7f7f',
  A: '#ffbf7f',
  B: '#ffdf7f',
  C: '#bfff7f',
  D: '#7fbfff',
};

export interface TierWork {
  item: WorkListItem;
  entry: TrackedMedia;
}

function zonesOf(works: TierWork[]): Zones {
  const zones: Zones = { S: [], A: [], B: [], C: [], D: [], pool: [] };
  for (const w of works) zones[w.item.tier ?? 'pool'].push(w.entry.id);
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
 * A tier list: rows S to D and the works not placed yet. Posters are dragged between rows and
 * within a row (mouse, finger after a short press, keyboard); the order and the tiers are saved
 * once, on drop.
 */
export function TierBoard({
  works,
  onSave,
  onRemove,
}: {
  works: TierWork[];
  onSave: (order: number[], changed: { trackedId: number; tier: ListTier | null }[]) => void;
  onRemove: (trackedId: number) => void;
}) {
  const { t, n } = useI18n();
  const sensors = useDragSensors();
  const initial = useMemo(() => zonesOf(works), [works]);
  const [draft, setDraft] = useState<Zones | null>(null);
  const latest = useRef<Zones | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const zones = draft ?? initial;
  const byId = useMemo(() => new Map(works.map((w) => [w.entry.id, w.entry])), [works]);
  const find = (z: Zones, id: UniqueIdentifier): Zone | undefined =>
    typeof id === 'string'
      ? (ZONES as string[]).includes(id)
        ? (id as Zone)
        : undefined
      : ZONES.find((zone) => z[zone].includes(id as number));
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
      const order = ZONES.flatMap((zone) => z![zone]);
      const was = new Map(ZONES.flatMap((zone) => initial[zone].map((id) => [id, zone] as const)));
      const changed = ZONES.flatMap((zone) =>
        z![zone]
          .filter((id) => was.get(id) !== zone)
          .map((id) => ({ trackedId: id, tier: zone === 'pool' ? null : zone })),
      );
      const before = ZONES.flatMap((zone) => initial[zone]);
      if (changed.length || order.some((id, i) => id !== before[i])) onSave(order, changed);
    }
    setDraft(null);
  };
  const cancel = () => {
    latest.current = null;
    setActive(null);
    setDraft(null);
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
        {TIERS.map((tier) => (
          <div
            key={tier}
            className="grid grid-cols-[52px_minmax(0,1fr)] gap-1 md:grid-cols-[76px_minmax(0,1fr)]"
          >
            <span
              className="font-display flex items-center justify-center text-2xl font-extrabold text-black md:text-3xl"
              style={{ background: COLORS[tier] }}
            >
              {tier}
            </span>
            <TierZone id={tier} ids={zones[tier]} byId={byId} onRemove={onRemove} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-mid text-sm">
          {t('lists.pool')} · {n(zones.pool.length)}
        </span>
        <TierZone id="pool" ids={zones.pool} byId={byId} onRemove={onRemove} pool />
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'ease-out' }}>
        {dragged ? (
          <Cover
            src={dragged.coverUrl ?? dragged.media.coverUrl}
            fallbacks={dragged.coverFallbacks}
            className="w-[60px] shadow-[0_16px_40px_rgba(0,0,0,0.6)] ring-2 ring-white md:w-[72px]"
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function TierZone({
  id,
  ids,
  byId,
  onRemove,
  pool = false,
}: {
  id: Zone;
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
          'flex min-h-[94px] flex-wrap content-start gap-1.5 p-1.5 transition-colors md:min-h-[112px]',
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
}

function Poster({ work, onRemove }: { work: TrackedMedia; onRemove: (trackedId: number) => void }) {
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
        'group relative w-[60px] cursor-grab active:cursor-grabbing md:w-[72px]',
        isDragging && 'opacity-30',
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
        className="bg-bg/85 absolute top-0.5 right-0.5 hidden size-6 items-center justify-center rounded-full text-white group-hover:flex focus-visible:flex"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
