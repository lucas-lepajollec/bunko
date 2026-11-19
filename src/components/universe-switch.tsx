'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { DiscoverKind } from '@/types/shared';
import { choiceLabel, useUniverse, type UniverseChoice } from '@/lib/client/universe';
import { isVideoKind } from '@/domain/kinds';
import { useI18n } from '@/i18n/I18nProvider';
import { announceMenu, onMenuOpened } from './select';
import { cx } from './ui';
import type { DiscoverPage, TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { kindOfMedia } from '@/domain/kinds';
import { Check, Puzzle } from 'lucide-react';
import { Cover } from './ui';
import { useLook } from '@/lib/client/theme';

/** The current universe's name: the extension section shown, else the kind. */
export function activeLabel(t: (k: string) => string, universe: ReturnType<typeof useUniverse>) {
  const name = universe.sections.find((s) => s.id === universe.section)?.name ?? null;
  return choiceLabel(t, { kind: universe.active, section: universe.section, name });
}
const isActive = (universe: ReturnType<typeof useUniverse>, c: UniverseChoice) =>
  universe.active === c.kind && (c.kind !== 'extension' || universe.section === c.section);

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
  if (reading.length + video.length + (universe.allowAll ? 1 : 0) < 2 && !universe.adultAllowed)
    return null;
  const item = (c: UniverseChoice, tall = false) => {
    const on = isActive(universe, c);
    return (
      <button
        key={`${c.kind}:${c.section ?? ''}`}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        onClick={() => {
          setOpen(false);
          void universe.set(c.kind, c.section);
        }}
        className={cx(
          'flex flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors',
          tall && 'w-full',
          on ? 'bg-white/[0.09]' : 'hover:bg-white/[0.06]',
        )}
      >
        <span
          className={cx(
            'flex items-center gap-2 text-[15px]',
            on ? 'font-semibold text-white' : 'text-fg',
          )}
        >
          {choiceLabel(t, c)}
          {on && <span aria-hidden className="size-1.5 rounded-full bg-[var(--accent,#9fb6ff)]" />}
        </span>
        <span className="text-muted text-[12px] leading-snug">{t(`universe.desc.${c.kind}`)}</span>
      </button>
    );
  };
  return (
    <div ref={root} className="relative hidden md:block">
      {/* Looks like the other header links; the panel opens on click or keyboard. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        className={cx(
          'app-universe flex items-center gap-1.5 text-[13px] xl:text-[15px]',
          open ? 'text-white' : 'text-mid hover:text-white',
        )}
      >
        {activeLabel(t, universe)}
        {universe.adultMode && <span className="text-warn text-[11px] font-semibold">18+</span>}
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
          'ui-panel border-line absolute top-full left-[-16px] z-50 mt-4 w-[740px] max-w-[calc(100vw-48px)] rounded-3xl border bg-panel/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-[opacity,transform] duration-200',
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
              {item({ kind: 'all', section: null, name: null }, true)}
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-muted px-3 pt-1 pb-1.5 text-[11px] tracking-[0.16em] uppercase">
              {t('universe.groupReading')}
            </span>
            <div className="grid grid-cols-2 gap-0.5">
              {universe.choices(reading).map((c) => item(c))}
            </div>
          </div>
          {video.length > 0 && (
            <div className="border-line flex flex-col gap-1 border-l pl-3">
              <span className="text-muted px-3 pt-1 pb-1.5 text-[11px] tracking-[0.16em] uppercase">
                {t('universe.groupVideo')}
              </span>
              {universe.choices(video).map((c) => item(c))}
            </div>
          )}
        </div>
        {universe.adultAllowed && (
          <AdultSwitch
            on={universe.adultMode}
            onChange={(next) => {
              setOpen(false);
              void universe.setAdultMode(next);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The whole interface in 18+ only, or back to everything else (when 18+ is allowed). */
function AdultSwitch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="border-line mt-3 flex w-full items-center gap-3 rounded-xl border-t px-3 pt-3 pb-1 text-left"
    >
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px]">{t('universe.adultMode')}</span>
        <span className="text-muted text-[12px] leading-snug">{t('universe.adultModeHint')}</span>
      </span>
      <span
        aria-hidden
        className={cx(
          'relative h-6 w-10 shrink-0 rounded-full transition-colors',
          on ? 'bg-[#c2410c]' : 'bg-white/[0.16]',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 size-5 rounded-full bg-white transition-[left]',
            on ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

/** Phone bottom bar: the universe as a tab that opens a sheet of choices. */
export function UniverseTab() {
  const { t } = useI18n();
  const look = useLook();
  const universe = useUniverse();
  const [open, setOpen] = useState(false);
  if (!universe.ready) return null;
  const options = universe.choices([
    ...(universe.allowAll ? ['all' as const] : []),
    ...universe.enabled,
  ]);
  if (options.length < 2 && !universe.adultAllowed) return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="relative flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-muted">
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
        <span className="max-w-full truncate">{activeLabel(t, universe)}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="ui-panel sheet-mobile bg-bg border-line fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col gap-2 overflow-y-auto rounded-t-[28px] border-t p-4 pb-[max(env(safe-area-inset-bottom),16px)] outline-none">
          <span aria-hidden className="mb-1 h-1 w-10 self-center rounded-full bg-white/25" />
          <Dialog.Title className="font-display text-[22px] font-extrabold tracking-[-0.03em]">
            {t('universe.label')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t('universe.hint')}
          </Dialog.Description>
          {look === 'cine' ? (
            <div className="-mx-3.5 -mb-3">
              <TypesPanel onDone={() => setOpen(false)} />
            </div>
          ) : (
            <>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {options.map((c) => (
                  <button
                    key={`${c.kind}:${c.section ?? ''}`}
                    type="button"
                    aria-pressed={isActive(universe, c)}
                    onClick={() => {
                      setOpen(false);
                      void universe.set(c.kind, c.section);
                    }}
                    className={cx(
                      'h-12 rounded-2xl px-4 text-left text-[15px]',
                      isActive(universe, c) ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.06]',
                    )}
                  >
                    {choiceLabel(t, c)}
                  </button>
                ))}
              </div>
              {universe.adultAllowed && (
                <AdultSwitch
                  on={universe.adultMode}
                  onChange={(next) => {
                    setOpen(false);
                    void universe.setAdultMode(next);
                  }}
                />
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Ciné: the type menu as poster tiles. Each kind shows a cover from the library and how many works
 * are followed; tabs narrow to reading or video; 18+ is a switch at the top. Shown in the header's
 * shared panel (CineHeader).
 */
export function TypesPanel({ onDone }: { onDone: () => void }) {
  const { t, n } = useI18n();
  const universe = useUniverse();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const [tab, setTab] = useState<'all' | 'reading' | 'video'>('all');
  if (!universe.ready) return null;
  // What the library holds per kind: how many works, and the one that stands for it — a favorite,
  // else the best rated, else the one read or watched last.
  const byKind = new Map<string, { count: number; best: TrackedMedia }>();
  const rank = (e: TrackedMedia) =>
    [e.favorite ? 1 : 0, e.rating ?? -1, Date.parse(e.lastReadAt ?? e.createdAt) || 0] as const;
  const better = (a: TrackedMedia, b: TrackedMedia) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
  };
  for (const e of library.data ?? []) {
    if (!(e.coverUrl ?? e.media.coverUrl)) continue;
    const k = kindOfMedia(e.media);
    const known = byKind.get(k);
    if (!known) byKind.set(k, { count: 1, best: e });
    else {
      known.count++;
      if (better(e, known.best)) known.best = e;
    }
  }
  const reading = universe.enabled.filter((k) => !isVideoKind(k));
  const video = universe.enabled.filter(isVideoKind);
  const pick = (c: UniverseChoice) => {
    onDone();
    void universe.set(c.kind, c.section);
  };
  const tile = (c: UniverseChoice) => {
    const info = byKind.get(c.kind);
    return (
      <KindTile
        key={`${c.kind}:${c.section ?? ''}`}
        choice={c}
        on={isActive(universe, c)}
        count={info?.count ?? 0}
        cover={info ? (info.best.coverUrl ?? info.best.media.coverUrl) : null}
        onPick={() => pick(c)}
      />
    );
  };
  const all = { kind: 'all' as const, section: null, name: null };
  const total = library.data?.length ?? 0;
  // "Everything": the work that stands for each kind, in the user's order.
  const mosaic = universe.order
    .map((k) => byKind.get(k)?.best)
    .filter((e): e is TrackedMedia => Boolean(e))
    .map((e) => e.coverUrl ?? e.media.coverUrl)
    .slice(0, 6);
  return (
    <div role="menu" aria-label={t('universe.label')} className="flex flex-col gap-1 p-3.5">
      <div className="flex items-center gap-3 px-1 pb-2.5">
        <span className="flex gap-0.5 rounded-full bg-white/[0.06] p-[3px] text-[13px]">
          {(['all', 'reading', 'video'] as const)
            .filter((x) => x !== 'video' || video.length > 0)
            .map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={tab === x}
                onClick={() => setTab(x)}
                className={cx(
                  'h-8 rounded-full px-3.5 transition-colors',
                  tab === x ? 'bg-white font-bold text-[#070b10]' : 'text-mid hover:text-white',
                )}
              >
                {t(
                  x === 'all'
                    ? 'universe.groupAll'
                    : x === 'reading'
                      ? 'universe.groupReading'
                      : 'universe.groupVideo',
                )}
              </button>
            ))}
        </span>
        <span className="flex-1" />
        {universe.adultAllowed && (
          <button
            type="button"
            role="switch"
            aria-checked={universe.adultMode}
            onClick={() => {
              onDone();
              void universe.setAdultMode(!universe.adultMode);
            }}
            className="text-mid flex items-center gap-2.5 text-[13px] hover:text-white"
          >
            {t('universe.adultMode')}
            <span
              aria-hidden
              className={cx(
                'relative h-[22px] w-9 shrink-0 rounded-full transition-colors',
                universe.adultMode ? 'bg-[#c2410c]' : 'bg-white/[0.16]',
              )}
            >
              <span
                className={cx(
                  'absolute top-0.5 size-[18px] rounded-full bg-white transition-[left]',
                  universe.adultMode ? 'left-4' : 'left-0.5',
                )}
              />
            </span>
          </button>
        )}
      </div>
      {universe.allowAll && tab === 'all' && (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={isActive(universe, all)}
          onClick={() => pick(all)}
          className={cx(
            'relative mb-2 flex h-[84px] items-end overflow-hidden rounded-[18px] px-4 py-3.5 text-left',
            isActive(universe, all) && 'shadow-[inset_0_0_0_1.5px_#fff]',
          )}
        >
          <span
            aria-hidden
            className="absolute inset-0 grid bg-[linear-gradient(120deg,#1b2733,#0e141b)]"
            style={{ gridTemplateColumns: `repeat(${Math.max(mosaic.length, 1)}, minmax(0, 1fr))` }}
          >
            {mosaic.map((src, i) => (
              <Cover key={i} src={src} alt="" className="!aspect-auto size-full !rounded-none" />
            ))}
          </span>
          <span
            aria-hidden
            className="absolute inset-0 bg-[linear-gradient(90deg,rgba(7,11,16,0.92)_0%,rgba(7,11,16,0.55)_60%,rgba(7,11,16,0.25)_100%)]"
          />
          <span className="relative flex flex-col">
            <span className="font-display flex items-center gap-2 text-[26px] leading-none">
              {choiceLabel(t, all)}
              {isActive(universe, all) && <Check className="size-4" strokeWidth={3} aria-hidden />}
            </span>
            <span className="text-mid text-[12.5px]">
              {t('universe.desc.all')}
              {total ? ` · ${t('universe.followed', { count: n(total) })}` : ''}
            </span>
          </span>
        </button>
      )}
      {tab !== 'video' && reading.length > 0 && (
        <>
          <span className="text-muted px-1 pt-1.5 pb-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
            {t('universe.groupReading')}
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {universe.choices(reading).map(tile)}
          </div>
        </>
      )}
      {tab !== 'reading' && video.length > 0 && (
        <>
          <span className="text-muted px-1 pt-3.5 pb-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
            {t('universe.groupVideo')}
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {universe.choices(video).map(tile)}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One kind in the type menu: the cover of the library work that stands for it, or (nothing of
 * that kind followed yet) the most popular work of the kind in the catalog.
 */
function KindTile({
  choice,
  on,
  count,
  cover,
  onPick,
}: {
  choice: UniverseChoice;
  on: boolean;
  count: number;
  cover: string | null;
  onPick: () => void;
}) {
  const { t, n } = useI18n();
  const popular = useApi<DiscoverPage>(
    !cover && choice.kind !== 'extension' ? `/api/discover?kind=${choice.kind}&sort=popular` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const src = cover ?? popular.data?.items.find((m) => m.coverUrl)?.coverUrl ?? null;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      onClick={onPick}
      className={cx(
        'group relative flex h-[84px] flex-col justify-end gap-0.5 overflow-hidden rounded-[16px] p-3 text-left transition-[background-color,box-shadow] duration-200',
        on
          ? 'bg-white/[0.14] shadow-[inset_0_0_0_1.5px_#fff]'
          : 'bg-white/[0.05] hover:bg-white/[0.09]',
      )}
    >
      {src ? (
        <Cover
          src={src}
          alt=""
          className="absolute -top-2 -right-3.5 w-[62px] rotate-[8deg] !rounded-[8px] opacity-95 shadow-[-6px_8px_20px_rgba(0,0,0,0.5)] transition-transform duration-300 group-hover:rotate-[4deg]"
        />
      ) : (
        choice.kind === 'extension' && (
          <Puzzle className="text-muted absolute top-3 right-3 size-5" aria-hidden />
        )
      )}
      <span className="relative flex items-center gap-1.5 pr-10 text-[14px] font-bold">
        <span className="truncate">{choiceLabel(t, choice)}</span>
        {on && <Check className="size-3.5 shrink-0" strokeWidth={3} aria-hidden />}
      </span>
      <span className="text-muted relative truncate pr-10 text-[11.5px]">
        {count ? t('universe.followed', { count: n(count) }) : t(`universe.desc.${choice.kind}`)}
      </span>
    </button>
  );
}
