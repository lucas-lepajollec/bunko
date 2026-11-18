'use client';
import type { CSSProperties, ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * Mouse after a few pixels, touch after a short press (scrolling stays a scroll), keyboard with
 * space then the arrows: the same sensors for every list that can be reordered.
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** A list or a grid reordered by dragging; `onReorder` gets the new order once, on drop. */
export function SortableList<Id extends UniqueIdentifier>({
  ids,
  onReorder,
  grid = false,
  children,
}: {
  ids: Id[];
  onReorder: (next: Id[]) => void;
  grid?: boolean;
  children: ReactNode;
}) {
  const sensors = useDragSensors();
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id as Id);
    const to = ids.indexOf(over.id as Id);
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
      <SortableContext
        items={ids}
        strategy={grid ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** One draggable item: its node, its moving style, and the props that make it grabbable. */
export function useSortableItem(id: UniqueIdentifier) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    position: 'relative',
    // The whole item is grabbed: a swipe still scrolls, a press then drag moves it.
    touchAction: 'manipulation',
    cursor: isDragging ? 'grabbing' : 'grab',
  };
  return {
    setNode: setNodeRef,
    style,
    dragging: isDragging,
    grab: { ...attributes, ...listeners },
  };
}

/**
 * A field inside a draggable item: a click focuses it, a press-and-drag still moves the item,
 * but typing (space, arrows) never starts a keyboard drag; Enter leaves the field.
 */
export const fieldInDraggable = {
  onKeyDown: (e: { stopPropagation: () => void; key: string; currentTarget: EventTarget }) => {
    e.stopPropagation();
    if (e.key === 'Enter') (e.currentTarget as HTMLElement).blur();
  },
};
/** A button inside a draggable item: pressing it never starts a drag. */
export const buttonInDraggable = {
  onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onMouseDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onTouchStart: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};
