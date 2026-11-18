'use client';
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * Reordering by a handle, with a mouse, a finger or the keyboard. While dragging, the item takes
 * the place of the nearest item under the pointer (lists and grids alike); the new order is
 * committed once, when it is dropped. `bounds` keeps an item within a range of places (equal
 * scores of a ranking move only among themselves).
 */
export function useSortable<Id extends string | number>(
  ids: readonly Id[],
  onCommit: (next: Id[]) => void,
  bounds?: (id: Id, order: readonly Id[]) => readonly [number, number],
) {
  const [draft, setDraft] = useState<Id[] | null>(null);
  const [dragging, setDragging] = useState<Id | null>(null);
  const nodes = useRef(new Map<Id, HTMLElement>());
  const current = useRef<Id[] | null>(null);
  const order = draft ?? (ids as Id[]);

  const limits = useCallback(
    (id: Id, list: readonly Id[]) => bounds?.(id, list) ?? ([0, list.length - 1] as const),
    [bounds],
  );
  const place = (list: Id[], id: Id, to: number) => {
    const from = list.indexOf(id);
    const [min, max] = limits(id, list);
    const target = Math.max(min, Math.min(max, to));
    if (from < 0 || target === from) return list;
    const next = list.filter((x) => x !== id);
    next.splice(target, 0, id);
    return next;
  };
  const finish = (commit: boolean) => {
    const next = current.current;
    current.current = null;
    setDragging(null);
    setDraft(null);
    if (commit && next && next.some((id, i) => id !== ids[i])) onCommit(next);
  };

  /** Ref for each sortable item (where it is on screen). */
  const item = (id: Id) => (node: HTMLElement | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  };
  /** Props for the item's drag handle (a button). */
  const handle = (id: Id) => ({
    style: { touchAction: 'none' as const, cursor: dragging === id ? 'grabbing' : 'grab' },
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      current.current = [...ids];
      setDraft([...ids]);
      setDragging(id);
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const list = current.current;
      if (!list || dragging !== id) return;
      let nearest = -1;
      let best = Infinity;
      list.forEach((other, i) => {
        const box = nodes.current.get(other)?.getBoundingClientRect();
        if (!box) return;
        const d = Math.hypot(
          e.clientX - (box.left + box.width / 2),
          e.clientY - (box.top + box.height / 2),
        );
        if (d < best) {
          best = d;
          nearest = i;
        }
      });
      if (nearest < 0) return;
      const next = place(list, id, nearest);
      if (next !== list) {
        current.current = next;
        setDraft(next);
      }
    },
    onPointerUp() {
      if (dragging === id) finish(true);
    },
    onPointerCancel() {
      if (dragging === id) finish(false);
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      const by = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (!by) return;
      e.preventDefault();
      const list = [...ids];
      const next = place(list, id, list.indexOf(id) + by);
      if (next !== list) onCommit(next);
    },
  });
  return { order, dragging, item, handle };
}
