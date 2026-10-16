'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

/*
 * Three levels of feedback, so screens stay calm:
 * - toast(): temporary confirmation or failure of an action, bottom of the screen, fades away;
 * - <InfoBubble>: a persistent but minor caveat, behind a small ⓘ;
 * - <Notice>: an important, persistent problem, shown above the content it affects.
 */

type Toast = {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
  link?: { href: string; label: string };
};
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(t: Omit<Toast, 'id'>) {
  const id = nextId++;
  // One message per text: repeating an action does not stack identical toasts.
  toasts = [...toasts.filter((x) => x.text !== t.text), { ...t, id }].slice(-3);
  emit();
  window.setTimeout(() => dismiss(id), t.tone === 'bad' ? 7000 : 4000);
}
function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster() {
  const { t } = useI18n();
  const list = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-24 z-[60] flex flex-col items-center gap-2 md:bottom-8"
    >
      {list.map((x) => (
        <div
          key={x.id}
          role={x.tone === 'bad' ? 'alert' : 'status'}
          className="animate-toast pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-full bg-[#1f1d1a] py-2.5 pr-2.5 pl-4 text-sm shadow-[0_16px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
        >
          <span
            aria-hidden
            className={cx(
              'size-2 shrink-0 rounded-full',
              x.tone === 'ok' ? 'bg-ok' : x.tone === 'bad' ? 'bg-bad' : 'bg-fg',
            )}
          />
          <span className="min-w-0">{x.text}</span>
          {x.link && (
            <Link href={x.link.href} className="text-mid shrink-0 underline hover:text-white">
              {x.link.label}
            </Link>
          )}
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => dismiss(x.id)}
            className="text-muted flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Small ⓘ that reveals a minor, persistent caveat on click (or keyboard). */
export function InfoBubble({
  children,
  tone = 'info',
  label,
  className,
}: {
  children: ReactNode;
  tone?: 'info' | 'warn';
  /** Accessible name of the trigger. */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span ref={ref} className={cx('relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'flex size-6 items-center justify-center rounded-full font-serif text-[13px] italic ring-1',
          tone === 'warn' ? 'text-warn ring-warn/50' : 'text-mid ring-white/25 hover:text-white',
        )}
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute top-8 left-1/2 z-40 w-[min(280px,80vw)] -translate-x-1/2 rounded-xl bg-[#1f1d1a] p-3 text-left text-sm leading-snug font-normal tracking-normal normal-case shadow-[0_16px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** Important persistent problem, placed above what it affects. */
export function Notice({
  tone = 'warn',
  title,
  children,
  action,
}: {
  tone?: 'warn' | 'bad';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/10 sm:flex-row sm:items-center"
    >
      <span
        aria-hidden
        className={cx(
          'mt-1.5 size-2 shrink-0 self-start rounded-full sm:mt-0 sm:self-center',
          tone === 'bad' ? 'bg-bad' : 'bg-warn',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {children && <span className="text-mid text-sm">{children}</span>}
      </span>
      {action && <span className="shrink-0">{action}</span>}
    </div>
  );
}
