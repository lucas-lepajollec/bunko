'use client';
import { useEffect, useId } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { setNotice } from '@/lib/client/notices';
import { Spinner, cx } from './ui';
import { InfoBubble } from './notify';

/** Visible alongside existing data: an empty/result list must not imply completion. */
export function LoadNotice({
  pending,
  partial,
  className,
  quiet = false,
  inline = false,
}: {
  /** Show the notice here rather than in the header bell. */
  inline?: boolean;
  pending?: boolean;
  partial?: boolean;
  className?: string;
  quiet?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  // General page status goes to the header's notice bell instead of interrupting the page;
  // `inline` keeps it in place where it describes a small list (search panel, pickers).
  useEffect(() => {
    if (inline) return;
    setNotice(id, { pending: Boolean(pending), partial: Boolean(partial) });
    return () => setNotice(id, null);
  }, [id, inline, pending, partial]);
  if (!inline) return null;
  if (!pending && !partial) return null;
  if (quiet)
    return (
      <div
        role="status"
        aria-live="polite"
        className={cx('text-muted flex items-center gap-2 text-xs', className)}
      >
        <span
          aria-hidden
          className={cx('size-1.5 shrink-0 rounded-full', partial ? 'bg-warn' : 'bg-fg/40')}
        />
        <span>{t(pending ? 'loading.pendingShort' : 'loading.partialShort')}</span>
        <InfoBubble label={t(pending ? 'loading.more' : 'loading.partial')}>
          {t(pending ? 'loading.more' : 'loading.partial')}
        </InfoBubble>
      </div>
    );
  return (
    <p
      role="status"
      aria-live="polite"
      className={cx(
        'flex items-start gap-2 text-sm leading-relaxed',
        partial && !pending ? 'text-warn' : 'text-mid',
        className,
      )}
    >
      {pending && <Spinner className="mt-0.5 size-4 shrink-0" />}
      <span>{t(pending ? 'loading.more' : 'loading.partial')}</span>
    </p>
  );
}
