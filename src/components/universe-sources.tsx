'use client';
import type { ReactNode } from 'react';
import { SOURCE_UNIVERSES, useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from './shell';
import { Empty } from './ui';

/**
 * Reading sources (Suwayomi extensions) exist for manga, manhwa, manhua and comics. In another
 * universe the source pages step aside instead of showing manga extensions.
 */
export function SourcesUniverseGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const universe = useUniverse();
  if (universe.ready && !SOURCE_UNIVERSES.includes(universe.active))
    return (
      <Page>
        <Empty title={t('universe.noSourcesTitle', { kind: t(`kind.${universe.active}`) })}>
          {t('universe.noSourcesBody')}
        </Empty>
      </Page>
    );
  return <>{children}</>;
}
