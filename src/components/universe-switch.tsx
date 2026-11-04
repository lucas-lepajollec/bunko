'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { DiscoverKind } from '@/types/shared';
import { useUniverse } from '@/lib/client/universe';
import { isVideoKind } from '@/domain/kinds';
import { useI18n } from '@/i18n/I18nProvider';
import { announceMenu, onMenuOpened } from './select';
import { cx } from './ui';

const label = (t: (k: string) => string, k: DiscoverKind) =>
  k === 'all' ? t('universe.all') : t(`kind.${k}`);

/** Desktop header: the current universe, opening on click (like any menu) to switch. */
export function UniverseMenu() {
  const { t } = useI18n();
  const universe = useUniverse();
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
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
    if (!open) announceMenu(id);
    setOpen(true);
  };
  if (!universe.ready) return null;
  const isVideo = (k: DiscoverKind) => isVideoKind(k);
  const reading = universe.enabled.filter((k) => !isVideo(k));
  const video = universe.enabled.filter(isVideo);
  if (reading.length + video.length + (universe.allowAll ? 1 : 0) < 2) return null;
  const item = (k: DiscoverKind, tall = false) => (
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
        'flex flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors',
        tall && 'h-full justify-start bg-white/[0.04] p-4',
        universe.active === k ? 'bg-white/[0.09]' : 'hover:bg-white/[0.06]',
      )}
    >
      <span
        className={cx(
          'flex items-center gap-2 text-[15px]',
          universe.active === k ? 'font-semibold text-white' : 'text-fg',
        )}
      >
        {label(t, k)}
        {universe.active === k && (
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--accent,#9fb6ff)]" />
        )}
      </span>
      <span className="text-muted text-[12px] leading-snug">{t(`universe.desc.${k}`)}</span>
    </button>
  );
  return (
    <div ref={root} className="relative hidden md:block">
      {/* Looks like the other header links; the panel opens on click or keyboard. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        className={cx(
          'flex items-center gap-1.5 text-[13px] xl:text-[15px]',
          open ? 'text-white' : 'text-mid hover:text-white',
        )}
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
          className={cx('transition-transform duration-200', open && 'rotate-180')}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        role="menu"
        aria-label={t('universe.label')}
        aria-hidden={!open}
        className={cx(
          'border-line absolute top-full left-[-16px] z-50 mt-4 w-[740px] max-w-[calc(100vw-48px)] rounded-3xl border bg-[#141210]/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-[opacity,transform] duration-200',
          open
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none invisible -translate-y-1 opacity-0',
        )}
      >
        {/* Everything on the side (all kinds together), then reading and video kinds. */}
        <div
          className={cx(
            'grid gap-3',
            universe.allowAll
              ? 'grid-cols-[170px_minmax(0,1.6fr)_minmax(0,1fr)]'
              : 'grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]',
          )}
        >
          {universe.allowAll && (
            <div className="border-line flex flex-col gap-1 border-r pr-3">
              <span className="text-muted px-3 pt-1 pb-1.5 text-[11px] tracking-[0.16em] uppercase">
                {t('universe.groupAll')}
              </span>
              <div className="flex-1">{item('all', true)}</div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-muted px-3 pt-1 pb-1.5 text-[11px] tracking-[0.16em] uppercase">
              {t('universe.groupReading')}
            </span>
            <div className="grid grid-cols-2 gap-0.5">{reading.map((k) => item(k))}</div>
          </div>
          {video.length > 0 && (
            <div className="border-line flex flex-col gap-1 border-l pl-3">
              <span className="text-muted px-3 pt-1 pb-1.5 text-[11px] tracking-[0.16em] uppercase">
                {t('universe.groupVideo')}
              </span>
              {video.map((k) => item(k))}
            </div>
          )}
        </div>
      </div>
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
