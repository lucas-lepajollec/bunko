'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  DownloadBatch,
  DownloadStatus,
  DownloadsSnapshot,
  PublicSettings,
} from '@/types/shared';
import { ApiFailure, mediaHref, openStream, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import { InfoBubble, toast } from '@/components/notify';
import {
  Cover,
  Dot,
  Empty,
  ErrorNote,
  PageTitle,
  Spinner,
  Tabs,
  cx,
  errorText,
  smallButton,
} from '@/components/ui';

type View = 'active' | 'failed' | 'history';

export default function DownloadsPage() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DownloadsSnapshot | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [view, setView] = useState<View>('active');
  const settings = useApi<PublicSettings>('/api/settings');
  const engine = useSuwayomi();
  useEffect(
    () =>
      openStream(
        '/api/downloads/stream',
        {
          snapshot: (d) => {
            setSnapshot(d as DownloadsSnapshot);
            setStreamError(null);
          },
          error: (d) => setStreamError((d as { code?: string }).code ?? 'STREAM_ERROR'),
        },
        () => setStreamError('NETWORK_ERROR'),
      ),
    [],
  );
  const batches = snapshot?.batches ?? [];
  const active = batches.filter((b) => b.state !== 'completed' && b.state !== 'error');
  const failed = batches.filter(hasFailures);
  const history = batches.filter((b) => b.state === 'completed' && !hasFailures(b));
  const shown = view === 'active' ? active : view === 'failed' ? failed : history;
  const status = snapshot?.status;
  const running = status?.state === 'STARTED';
  async function control(action: 'pause' | 'resume' | 'clear') {
    try {
      const next = await send<DownloadStatus>('/api/downloads/control', 'POST', { action });
      setSnapshot((s) => (s ? { ...s, status: next } : s));
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    }
  }
  return (
    <Page className="pb-16 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-[72px]">
      <div className="flex min-w-0 flex-col gap-6">
        <PageTitle
          title={t('downloads.title')}
          aside={
            snapshot
              ? t('downloads.aside', { active: active.length, failed: failed.length })
              : undefined
          }
        />
        <div className="md:hidden">
          <Link
            href="/updates"
            className="text-mid flex min-h-11 items-center justify-between rounded-2xl bg-white/[0.05] px-4 text-[15px]"
          >
            {t('nav.updates')} <span aria-hidden>›</span>
          </Link>
        </div>
        <Tabs
          value={view}
          onChange={setView}
          label={t('downloads.filter')}
          items={[
            { id: 'active', label: t('downloads.active'), count: active.length },
            { id: 'failed', label: t('downloads.failed'), count: failed.length, tone: 'bad' },
            { id: 'history', label: t('downloads.history') },
          ]}
        />
        {engine.state && engine.state !== 'ok' ? (
          <SuwayomiNotice />
        ) : (
          streamError && <ErrorNote error={new ApiFailure(streamError, 0)} />
        )}
        {snapshot && shown.length === 0 && (
          <Empty title={t(`downloads.empty.${view}`)}>
            {view === 'active' ? t('downloads.emptyBody') : null}
          </Empty>
        )}
        {shown.map((b) => (
          <BatchCard key={b.id} batch={b} />
        ))}
      </div>
      <aside className="mt-10 flex flex-col gap-5 md:mt-[30px]">
        <div className="flex flex-col gap-3.5 rounded-[18px] bg-white/[0.05] p-5 md:p-[22px]">
          <span className="text-muted text-xs tracking-[0.16em] uppercase">
            {t('downloads.engine')}
          </span>
          <span className="flex items-center gap-2.5 font-serif text-2xl">
            <Dot tone={!status ? 'idle' : running ? 'ok' : 'warn'} className="size-[9px]" />
            {!status ? '—' : running ? t('downloads.running') : t('downloads.stopped')}
          </span>
          <div className="flex gap-2.5">
            <button
              type="button"
              disabled={!status}
              onClick={() => control(running ? 'pause' : 'resume')}
              className={cx(smallButton, 'h-11 flex-1 text-sm')}
            >
              {running ? t('downloads.pause') : t('downloads.resume')}
            </button>
            <button
              type="button"
              disabled={!status?.queue.length}
              onClick={() => window.confirm(t('downloads.clearConfirm')) && control('clear')}
              className="border-line-strong h-11 flex-1 rounded-full border text-sm disabled:opacity-40"
            >
              {t('downloads.clear')}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-[18px] bg-white/[0.05] p-5 text-sm md:p-[22px]">
          <span className="text-muted mb-2.5 text-xs tracking-[0.16em] uppercase">
            {t('downloads.destination')}
          </span>
          <div className="flex min-h-9 items-center justify-between gap-4">
            <span className="text-mid">{t('downloads.format')}</span>
            <span>CBZ + ComicInfo</span>
          </div>
          <div className="flex min-h-9 items-center justify-between gap-4">
            <span className="text-mid">{t('downloads.folder')}</span>
            <span className="truncate font-mono text-xs">
              {settings.data?.kavitaLibraryPath ?? '—'}
            </span>
          </div>
        </div>
        <nav className="flex flex-col md:hidden" aria-label={t('downloads.more')}>
          <Link
            href="/sources"
            className="border-line flex min-h-14 items-center justify-between border-b text-[15px]"
          >
            {t('nav.sources')}{' '}
            <span aria-hidden className="text-muted">
              ›
            </span>
          </Link>
          <Link href="/settings" className="flex min-h-14 items-center justify-between text-[15px]">
            {t('nav.settings')}{' '}
            <span aria-hidden className="text-muted">
              ›
            </span>
          </Link>
        </nav>
      </aside>
    </Page>
  );
}

const hasFailures = (b: DownloadBatch) =>
  b.state === 'error' || b.chapters.some((c) => c.state === 'error');
const PREVIEW = 8;

function BatchCard({ batch }: { batch: DownloadBatch }) {
  const { t, n } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const total = batch.chapters.length || batch.chapterIds.length;
  const done = batch.chapters.filter((c) => c.state === 'done').length;
  const failed = batch.chapters.filter((c) => c.state === 'error');
  const finished = batch.state === 'completed' || batch.state === 'error';
  // Most useful first: running, then failed, then waiting, then done.
  const order = { downloading: 0, importing: 0, error: 1, queued: 2, done: 3 } as const;
  const rows = [...batch.chapters].sort((a, b) => order[a.state] - order[b.state]);
  const shown = expanded ? rows : rows.slice(0, PREVIEW);
  async function act(body: object, ok: string) {
    setWorking(true);
    try {
      await send('/api/downloads/control', 'POST', body);
      toast({ tone: 'ok', text: ok });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setWorking(false);
    }
  }
  const stepLabel =
    batch.state === 'error'
      ? errorLabel(t, batch.error, 'downloads.failedGeneric')
      : t(`downloads.state.${batch.state}`);
  return (
    <section className="flex flex-col gap-4 rounded-[18px] bg-white/[0.04] p-4 md:p-[22px]">
      <div className="flex items-center gap-3.5">
        <Cover src={batch.media.coverUrl} className="w-11 shrink-0 md:w-[52px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            href={mediaHref(batch.media.id)}
            className="truncate text-base font-semibold hover:underline md:text-lg"
          >
            {batch.media.title}
          </Link>
          <span className="text-muted flex flex-wrap items-center gap-x-2 text-xs md:text-[13px]">
            <span>{t('downloads.doneOf', { done: n(done), total: n(total) })}</span>
            {failed.length > 0 && (
              <span className="text-bad">
                · {t('downloads.failedCount', { count: failed.length })}
              </span>
            )}
            <span
              className={cx('flex items-center gap-1.5', batch.state === 'error' && 'text-bad')}
            >
              · {!finished && <Spinner className="size-3" />}
              {stepLabel}
            </span>
            {batch.scan?.state === 'failed' && (
              <InfoBubble tone="warn" label={t('downloads.scanFailedLabel')}>
                {t('downloads.scanFailed', {
                  reason: errorLabel(t, batch.scan.error, 'error.KAVITA_SCAN_ERROR'),
                })}
              </InfoBubble>
            )}
          </span>
        </span>
        <div className="flex shrink-0 gap-2">
          {failed.length > 0 && (
            <button
              type="button"
              disabled={working}
              onClick={() =>
                act(
                  { action: 'retry_failed', batchId: batch.id },
                  t('downloads.retrying', { count: failed.length }),
                )
              }
              className="bg-fg text-bg h-9 rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
            >
              {t('downloads.retryFailed')}
            </button>
          )}
          <button
            type="button"
            disabled={working}
            aria-label={finished ? t('downloads.remove') : t('downloads.cancel')}
            title={finished ? t('downloads.remove') : t('downloads.cancel')}
            onClick={() =>
              (finished || window.confirm(t('downloads.cancelConfirm'))) &&
              act({ action: 'remove', batchId: batch.id }, t('downloads.removed'))
            }
            className="text-mid flex size-9 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>
      <span className="h-1 overflow-hidden rounded-full bg-white/10">
        <span
          className="bg-ok block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </span>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {shown.map((c) => (
            <li
              key={c.id}
              className="border-line relative flex min-h-[44px] items-center gap-3 overflow-hidden border-b px-1 text-sm last:border-b-0"
            >
              {c.state === 'downloading' && c.progress !== null && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-[#7aa2ff]/[0.14]"
                  style={{ width: `${Math.round(c.progress * 100)}%` }}
                />
              )}
              <span className="relative min-w-0 flex-1 truncate">
                <span className="font-serif text-[18px]">
                  {c.number !== null ? t('chapters.number', { n: n(c.number) }) : c.name}
                </span>
                <span className="text-muted ml-2 text-xs">{c.sourceName}</span>
              </span>
              <span
                className={cx(
                  'relative flex shrink-0 items-center gap-1.5 text-right text-[13px]',
                  c.state === 'error' ? 'text-bad' : c.state === 'done' ? 'text-ok' : 'text-mid',
                )}
              >
                {(c.state === 'downloading' || c.state === 'importing') && (
                  <Spinner className="size-3" />
                )}
                {c.state === 'error'
                  ? errorLabel(t, c.error, 'downloads.itemError')
                  : c.state === 'downloading' && c.progress !== null
                    ? t('downloads.percent', { n: Math.round(c.progress * 100) })
                    : t(`downloads.chapter.${c.state}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-mid self-start text-sm hover:text-white"
        >
          {expanded ? t('common.less') : t('downloads.showAll', { count: n(rows.length) })}
        </button>
      )}
    </section>
  );
}

function errorLabel(t: (k: string) => string, code: string | null, fallback: string) {
  return code && t(`error.${code}`) !== `error.${code}` ? t(`error.${code}`) : t(fallback);
}
