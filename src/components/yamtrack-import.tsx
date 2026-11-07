'use client';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import type { YamtrackImportState } from '@/types/shared';
import { parseYamtrack, type YamtrackParse } from '@/domain/yamtrack';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { toast } from './notify';
import { ErrorNote, Spinner, cx, errorText, primaryButton, smallButton } from './ui';

/**
 * Settings → Import: a Yamtrack CSV export becomes library works with their status, score and
 * progress. The file is read here; only the works go to the server.
 */
export function YamtrackImport() {
  const { t, n } = useI18n();
  const { mutate } = useSWRConfig();
  const job = useApi<YamtrackImportState>('/api/import/yamtrack', {
    refreshInterval: (data) => (data?.running ? 1500 : 0),
  });
  const [parsed, setParsed] = useState<(YamtrackParse & { name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const state = job.data;
  const counts = parsed
    ? parsed.entries.reduce<Record<string, number>>((c, e) => {
        c[e.type] = (c[e.type] ?? 0) + 1;
        return c;
      }, {})
    : {};
  const rated = parsed?.entries.filter((e) => e.score !== null).length ?? 0;
  const skippedTotal = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);
  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-lg font-semibold">{t('import.yamtrack.title')}</h3>
        <p className="text-mid text-sm leading-relaxed">{t('import.yamtrack.hint')}</p>
      </div>
      <label
        className={cx(
          smallButton,
          'cursor-pointer self-start',
          (busy || state?.running) && 'pointer-events-none opacity-50',
        )}
      >
        {t('import.yamtrack.pick')}
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setError(null);
            setParsed(null);
            try {
              const result = parseYamtrack(await file.text());
              if (!result.entries.length) setError(t('import.yamtrack.empty'));
              else setParsed({ ...result, name: file.name });
            } catch {
              setError(t('import.yamtrack.invalid'));
            }
          }}
        />
      </label>
      {error && <p className="text-bad text-sm">{error}</p>}
      {parsed && !state?.running && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 text-sm">
          <span className="font-semibold">{parsed.name}</span>
          <span className="text-mid">
            {Object.entries(counts)
              .map(([type, count]) => `${t(`import.yamtrack.type.${type}`)} ${n(count)}`)
              .join(' · ')}
          </span>
          <span className="text-mid">{t('import.yamtrack.rated', { count: n(rated) })}</span>
          {skippedTotal(parsed.skipped) > 0 && (
            <span className="text-muted">
              {t('import.yamtrack.skipped', {
                count: n(skippedTotal(parsed.skipped)),
                types: Object.keys(parsed.skipped).join(', '),
              })}
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            className={cx(primaryButton, 'self-start')}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await send<YamtrackImportState>('/api/import/yamtrack', 'POST', {
                  entries: parsed.entries.map((e) => ({ ...e, title: e.title.slice(0, 500) })),
                  skipped: parsed.skipped,
                });
                await job.mutate(next, { revalidate: true });
                setParsed(null);
              } catch (e) {
                toast({ tone: 'bad', text: errorText(t, e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {t('import.yamtrack.start', { count: n(parsed.entries.length) })}
          </button>
        </div>
      )}
      {job.error && <ErrorNote error={job.error} />}
      {state && (state.running || state.finishedAt) && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 text-sm">
          {state.running ? (
            <>
              <span className="flex items-center gap-2">
                <Spinner />
                {state.phase === 'resolving'
                  ? t('import.yamtrack.resolving', { done: n(state.found), total: n(state.total) })
                  : t('import.yamtrack.running', { done: n(state.done), total: n(state.total) })}
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <span
                  className="bg-fg block h-full rounded-full transition-[width]"
                  style={{
                    // Looking up is the first half of the bar, following works the second.
                    width: `${state.total ? ((state.phase === 'resolving' ? state.found : state.total + state.done) / (2 * state.total)) * 100 : 0}%`,
                  }}
                />
              </span>
            </>
          ) : (
            <ImportReport
              state={state}
              onSeen={() => void mutate('/api/tracked')}
              skipped={skippedTotal(state.skipped)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ImportReport({
  state,
  skipped,
  onSeen,
}: {
  state: YamtrackImportState;
  skipped: number;
  onSeen: () => void;
}) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="font-semibold">
        {t('import.yamtrack.done', { added: n(state.added), updated: n(state.updated) })}
      </span>
      {skipped > 0 && (
        <span className="text-muted">
          {t('import.yamtrack.skipped', {
            count: n(skipped),
            types: Object.keys(state.skipped).join(', '),
          })}
        </span>
      )}
      {state.unmatchedCount > 0 && (
        <>
          <button
            type="button"
            className="text-mid self-start underline hover:text-white"
            onClick={() => {
              setOpen(!open);
              onSeen();
            }}
          >
            {t('import.yamtrack.unmatched', { count: n(state.unmatchedCount) })}
          </button>
          {open && (
            <ul className="text-mid flex max-h-72 flex-col gap-1 overflow-y-auto">
              {state.unmatched.map((u, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="truncate">{u.title}</span>
                  <span className="text-muted shrink-0 text-xs">
                    {t(`import.yamtrack.type.${u.type}`)} · {u.source} ·{' '}
                    {t(`import.yamtrack.reason.${u.reason}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
