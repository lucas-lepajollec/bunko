'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { DiscoverKind } from '@/types/shared';
import { useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { announceMenu, onMenuOpened } from './select';
import { cx } from './ui';

const label = (t: (k: string) => string, k: DiscoverKind) =>
  k === 'all' ? t('universe.all') : t(`kind.${k}`);

/** Desktop header: the current universe, opening on hover (or click) to switch. */
export function UniverseMenu() {
  const { t } = useI18n();
  const universe = useUniverse();
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => onMenuOpened((other) => other !== id && setOpen(false)), [id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const show = () => {
    clearTimeout(timer.current);
    if (!open) announceMenu(id);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 160);
  };
  if (!universe.ready) return null;
  const options: DiscoverKind[] = [
    ...(universe.allowAll ? ['all' as const] : []),
    ...universe.enabled,
  ];
  if (options.length < 2) return null;
  return (
    <div ref={root} className="relative hidden md:block" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        className="flex h-9 items-center gap-1.5 rounded-full bg-white/[0.08] px-3.5 text-[13px] text-white hover:bg-white/[0.12] xl:text-sm"
      >
        {label(t, universe.active)}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('universe.label')}
          className="border-line absolute top-11 left-0 z-50 flex w-56 flex-col rounded-2xl border bg-[#141210] p-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        >
          {options.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={universe.active === k}
              onClick={() => {
                setOpen(false);
                void universe.set(k);
              }}
              className={cx(
                'flex h-10 items-center justify-between rounded-xl px-3 text-left text-sm',
                universe.active === k
                  ? 'bg-white/[0.1] font-semibold text-white'
                  : 'text-mid hover:bg-white/[0.06] hover:text-white',
              )}
            >
              {label(t, k)}
              {universe.active === k && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Phone bottom bar: the universe as a tab that opens a sheet of choices. */
export function UniverseTab() {
  const { t } = useI18n();
  const universe = useUniverse();
  const [open, setOpen] = useState(false);
  if (!universe.ready) return null;
  const options: DiscoverKind[] = [
    ...(universe.allowAll ? ['all' as const] : []),
    ...universe.enabled,
  ];
  if (options.length < 2) return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="relative flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#8c867e]">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
        <span className="max-w-full truncate">{label(t, universe.active)}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 rounded-t-3xl border-t p-4 pb-[max(env(safe-area-inset-bottom),16px)] outline-none">
          <span aria-hidden className="mb-1 h-1 w-10 self-center rounded-full bg-white/25" />
          <Dialog.Title className="font-display text-[22px] font-extrabold tracking-[-0.03em]">
            {t('universe.label')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t('universe.hint')}
          </Dialog.Description>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {options.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={universe.active === k}
                onClick={() => {
                  setOpen(false);
                  void universe.set(k);
                }}
                className={cx(
                  'h-12 rounded-2xl px-4 text-left text-[15px]',
                  universe.active === k ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.06]',
                )}
              >
                {label(t, k)}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
