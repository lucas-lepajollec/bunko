'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import type { TrackedMedia } from '@/types/shared';
import { isVideoKind, kindOfMedia } from '@/domain/kinds';
import { send } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from './select';
import { toast } from './notify';
import { Spinner, cx, errorText } from './ui';

type Action = 'remove' | 'complete' | 'status' | 'favorite' | 'unfavorite';
type Status = TrackedMedia['status'];
const STATUSES: Status[] = ['READING', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED'];

/** The tick shown on a work's poster while the library is in selection mode. */
export function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'absolute top-2 left-2 z-10 flex size-7 items-center justify-center rounded-full border-2 transition-colors',
        selected ? 'border-white bg-white text-black' : 'border-white/80 bg-black/45',
      )}
    >
      {selected && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
        >
          <path d="m5 12 5 5 9-10" />
        </svg>
      )}
    </span>
  );
}

/**
 * Bottom bar of the library's selection mode: count, select all, and the actions on the selected
 * works. Removing, finishing and status changes ask first; favorites apply at once (reversible).
 */
export function SelectionBar({
  selected,
  visible,
  onSelectAll,
  onClear,
  onClose,
  onDone,
}: {
  selected: TrackedMedia[];
  /** Works currently shown (what "select all" takes). */
  visible: number;
  onSelectAll: () => void;
  onClear: () => void;
  onClose: () => void;
  onDone: (removed: boolean) => Promise<unknown>;
}) {
  const { t, n } = useI18n();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ action: Action; status?: Status } | null>(null);
  const count = selected.length;
  // Words follow what is selected: read, watched, or finished when both are mixed.
  const video = selected.filter((e) => isVideoKind(kindOfMedia(e.media))).length;
  const familyKey = (key: string) =>
    video === 0 ? `${key}.reading` : video === count ? `${key}.video` : key;
  const statusLabel = (s: Status) => {
    const key = `shelf.${s}`;
    return video === count && count > 0 && t(`${key}.video`) !== `${key}.video`
      ? t(`${key}.video`)
      : t(key);
  };
  const allFavorite = count > 0 && selected.every((e) => e.favorite);
  const run = async (action: Action, status?: Status) => {
    setBusy(true);
    try {
      const result = await send<{ changed: number }>('/api/tracked/bulk', 'POST', {
        ids: selected.map((e) => e.id),
        action,
        ...(status ? { status } : {}),
      });
      toast({
        tone: 'ok',
        text: t(action === 'remove' ? 'bulk.removed' : 'bulk.done', { count: n(result.changed) }),
      });
      setAsking(null);
      await onDone(action === 'remove');
    } catch (error) {
      toast({ tone: 'bad', text: errorText(t, error) });
    } finally {
      setBusy(false);
    }
  };
  const action =
    'inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-white/[0.1] px-4 text-[13px] whitespace-nowrap transition-colors hover:bg-white/[0.16] disabled:opacity-40';
  return (
    <>
      <div
        role="toolbar"
        aria-label={t('library.selected', { count: n(count) })}
        className="border-line fixed inset-x-3 bottom-[calc(max(env(safe-area-inset-bottom),12px)+70px)] z-40 flex flex-col gap-2.5 rounded-2xl border bg-[#161412]/95 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[min(920px,calc(100vw-48px))] md:-translate-x-1/2"
      >
        <div className="flex items-center gap-2">
          <span
            className={cx(
              'min-w-0 flex-1 truncate tabular-nums',
              count ? 'font-semibold' : 'text-mid text-sm',
            )}
          >
            {count ? t('library.selected', { count: n(count) }) : t('library.selectHint')}
          </span>
          <button
            type="button"
            onClick={count >= visible && visible > 0 ? onClear : onSelectAll}
            disabled={!visible}
            className="text-mid shrink-0 text-[13px] whitespace-nowrap underline decoration-white/30 underline-offset-4 hover:text-white disabled:opacity-40"
          >
            {count >= visible && visible > 0 ? t('library.selectNone') : t('library.selectAll')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="bg-fg text-bg ml-1 inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-[13px] font-semibold"
          >
            {t('library.selectDone')}
          </button>
        </div>
        {/* One scrolling row on phones, wrapped on wider screens. */}
        <div className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 md:flex-wrap">
          <button
            type="button"
            disabled={!count || busy}
            onClick={() => setAsking({ action: 'complete' })}
            className={action}
          >
            {t(familyKey('bulk.complete'))}
          </button>
          <Select
            label={t('bulk.status')}
            value=""
            size="sm"
            onChange={(v) => v && count && setAsking({ action: 'status', status: v as Status })}
            options={[
              { value: '', label: t('bulk.status') },
              ...STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
            ]}
            className={cx('shrink-0', (!count || busy) && 'pointer-events-none opacity-40')}
          />
          <button
            type="button"
            disabled={!count || busy}
            onClick={() => void run(allFavorite ? 'unfavorite' : 'favorite')}
            className={action}
          >
            {t(allFavorite ? 'bulk.unfavorite' : 'bulk.favorite')}
          </button>
          <button
            type="button"
            disabled={!count || busy}
            onClick={() => setAsking({ action: 'remove' })}
            className={cx(action, 'text-bad bg-[#c2410c]/15 hover:bg-[#c2410c]/25')}
          >
            {t('bulk.remove')}
          </button>
        </div>
      </div>
      <Dialog.Root open={Boolean(asking)} onOpenChange={(o) => !o && !busy && setAsking(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content className="border-line fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-50 flex flex-col gap-3 rounded-3xl border bg-[#161412] p-5 outline-none md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:w-[440px] md:-translate-x-1/2 md:-translate-y-1/2">
            {asking && (
              <>
                <Dialog.Title className="font-display text-[20px] leading-tight font-bold">
                  {t(`bulk.confirm.${asking.action}`, {
                    count: n(count),
                    status: asking.status ? statusLabel(asking.status) : '',
                  })}
                </Dialog.Title>
                <Dialog.Description className="text-mid text-sm">
                  {t(`bulk.confirm.${asking.action}Body`)}
                </Dialog.Description>
                <ul className="text-muted max-h-32 overflow-y-auto text-xs leading-relaxed">
                  {selected.slice(0, 8).map((e) => (
                    <li key={e.id} className="truncate">
                      {e.title}
                    </li>
                  ))}
                  {count > 8 && <li>{t('common.moreCount', { count: n(count - 8) })}</li>}
                </ul>
                <div className="mt-1 flex gap-2">
                  <Dialog.Close
                    disabled={busy}
                    className="h-11 flex-1 rounded-full bg-white/[0.1] text-sm hover:bg-white/[0.16]"
                  >
                    {t('common.cancel')}
                  </Dialog.Close>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(asking.action, asking.status)}
                    className={cx(
                      'inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm font-semibold disabled:opacity-60',
                      asking.action === 'remove' ? 'bg-[#dc2626] text-white' : 'bg-fg text-bg',
                    )}
                  >
                    {busy && <Spinner />}
                    {asking.action === 'remove'
                      ? t('bulk.remove')
                      : asking.action === 'complete'
                        ? t(familyKey('bulk.complete'))
                        : statusLabel(asking.status!)}
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
