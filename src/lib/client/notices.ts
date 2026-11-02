'use client';
import { useSyncExternalStore } from 'react';

/** Page-level status that used to be inline text: still loading, or incomplete results. */
export interface PageNotice {
  pending: boolean;
  partial: boolean;
  /** Named work with progress (e.g. a source search on the page): shown as a task. */
  task?: { label: string; done: number; total: number | null };
}
const notices = new Map<string, PageNotice>();
const listeners = new Set<() => void>();
let snapshot: PageNotice[] = [];
const emit = () => {
  snapshot = [...notices.values()];
  for (const l of listeners) l();
};
export function setNotice(id: string, notice: PageNotice | null) {
  const old = notices.get(id);
  if (!notice || (!notice.pending && !notice.partial)) {
    if (old) {
      notices.delete(id);
      emit();
    }
    return;
  }
  if (
    old &&
    old.pending === notice.pending &&
    old.partial === notice.partial &&
    JSON.stringify(old.task) === JSON.stringify(notice.task)
  )
    return;
  notices.set(id, notice);
  emit();
}
/** Every notice shown by the pages currently mounted. */
export function useNotices() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}
