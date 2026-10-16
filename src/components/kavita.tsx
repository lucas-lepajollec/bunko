'use client';
import { useState } from 'react';
import type { KavitaSeriesSummary } from '@/types/shared';
import { ApiFailure, send } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, Empty, PosterSkeletons, errorText } from './ui';

/** Series already in Kavita that Bunko does not follow yet, with a one-click "follow". */
export function KavitaUnmatched({
  series,
  onTracked,
}: {
  series: KavitaSeriesSummary[] | undefined;
  onTracked: () => Promise<unknown>;
}) {
  const { t, n } = useI18n();
  const [busy, setBusy] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  if (series && series.length === 0) return <Empty title={t('kavita.allTracked')} />;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-mid max-w-3xl text-sm leading-relaxed">{t('kavita.unmatchedHint')}</p>
      <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-7">
        {!series && <PosterSkeletons count={7} />}
        {series?.map((s) => (
          <div key={s.seriesId} className="flex min-w-0 flex-col gap-2.5">
            <Cover src={s.coverUrl} alt={s.name} />
            <span className="line-clamp-2 text-xs leading-snug font-medium md:text-sm">
              {s.name}
            </span>
            <span className="text-muted -mt-1 truncate text-xs">
              {s.libraryName} · {t('kavita.chapterCount', { n: n(s.chapters) })}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(s.seriesId);
                try {
                  await send('/api/kavita/track', 'POST', { seriesId: s.seriesId });
                  await onTracked();
                } catch (e) {
                  setNotes((x) => ({
                    ...x,
                    [s.seriesId]:
                      e instanceof ApiFailure && e.code === 'NO_MATCH'
                        ? t('kavita.noMatch')
                        : errorText(t, e),
                  }));
                } finally {
                  setBusy(null);
                }
              }}
              className="bg-fg text-bg h-9 rounded-full text-[13px] font-semibold disabled:opacity-50"
            >
              {busy === s.seriesId ? t('common.working') : t('kavita.follow')}
            </button>
            {notes[s.seriesId] && (
              <span className="text-warn text-xs leading-snug">{notes[s.seriesId]}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
