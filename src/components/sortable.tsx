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

/** One draggable item: its node, its moving style, and the props of its handle. */
export function useSortableItem(id: UniqueIdentifier) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    position: 'relative',
  };
  return {
    setNode: setNodeRef,
    style,
    dragging: isDragging,
    handle: { ...attributes, ...listeners, style: { touchAction: 'none' as const } },
  };
}
