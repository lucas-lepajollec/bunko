'use client';
import { useI18n } from '@/i18n/I18nProvider';
import { Spinner, cx } from './ui';

/** Visible alongside existing data: an empty/result list must not imply completion. */
export function LoadNotice({
  pending,
  partial,
  className,
}: {
  pending?: boolean;
  partial?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  if (!pending && !partial) return null;
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
