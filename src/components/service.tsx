'use client';
import Link from 'next/link';
import type { ServicesStatus } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Empty, smallButton } from './ui';

/** Suwayomi reachability, shared by every screen that depends on the engine. */
export function useSuwayomi() {
  const status = useApi<ServicesStatus>('/api/status', { refreshInterval: 60_000 });
  return { state: status.data?.suwayomi.state, loading: !status.data && !status.error };
}

/** Explains why engine-backed content is missing, instead of a raw upstream error. */
export function SuwayomiNotice() {
  const { t } = useI18n();
  const { state } = useSuwayomi();
  if (!state || state === 'ok') return null;
  return (
    <Empty
      title={
        state === 'unconfigured' ? t('service.suwayomiUnconfigured') : t('service.suwayomiDown')
      }
      action={
        <Link href="/settings#connections" className={smallButton}>
          {t('service.openSettings')} →
        </Link>
      }
    >
      {t('service.suwayomiBody')}
    </Empty>
  );
}
