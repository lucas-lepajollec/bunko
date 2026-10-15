'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  DownloadBatch,
  DownloadItem,
  DownloadStatus,
  DownloadsSnapshot,
  PublicSettings,
} from '@/types/shared';
import { ApiFailure, mediaHref, openStream, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import {
  Cover,
  Dot,
  Empty,
  ErrorNote,
  PageTitle,
  Tabs,
  cx,
  errorText,
  smallButton,
} from '@/components/ui';

type View = 'active' | 'failed' | 'history';
const STEPS = ['download', 'import', 'scan', 'ready'] as const;
const stepIndex = (b: DownloadBatch) =>
  ({ enqueuing: 0, downloading: 0, importing: 1, scanning: 2, completed: 3, error: -1 })[b.state];

export default function DownloadsPage() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DownloadsSnapshot | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [view, setView] = useState<View>('active');
  const [notice, setNotice] = useState<string | null>(null);
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
  const failed = batches.filter((b) => b.state === 'error');
  const history = batches.filter((b) => b.state === 'completed');
  const shown = view === 'active' ? active : view === 'failed' ? failed : history;
  const status = snapshot?.status;
  const running = status?.state === 'STARTED';
  async function control(action: 'pause' | 'resume' | 'clear') {
    setNotice(null);
    try {
      const next = await send<DownloadStatus>('/api/downloads/control', 'POST', { action });
      setSnapshot((s) => (s ? { ...s, status: next } : s));
    } catch (e) {
      setNotice(errorText(t, e));
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
          <BatchCard key={b.id} batch={b} queue={status?.queue ?? []} />
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
          {notice && <p className="text-bad text-sm">{notice}</p>}
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

function BatchCard({ batch, queue }: { batch: DownloadBatch; queue: DownloadItem[] }) {
  const { t, n } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const step = stepIndex(batch);
  const items = queue.filter((q) => batch.chapterIds.includes(q.chapter.id)).slice(0, 6);
  const done = batch.importedIds.length;
  return (
    <section className="flex flex-col gap-3.5 rounded-[18px] bg-white/[0.04] p-4 md:p-[22px]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-[18px]">
        <div className="flex min-w-0 items-center gap-3.5">
          <Cover src={batch.media.coverUrl} className="w-10 shrink-0 md:w-[52px]" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <Link
              href={mediaHref(batch.media.id)}
              className="truncate text-base font-semibold hover:underline md:text-lg"
            >
              {batch.media.title}
            </Link>
            <span className="text-muted text-xs md:text-[13px]">
              {t('downloads.batchLine', { count: n(batch.chapterIds.length), done: n(done) })}
            </span>
          </span>
        </div>
        {batch.state === 'error' ? (
          <div className="flex items-center gap-3 md:ml-auto">
            <span className="text-bad font-serif text-[17px] italic">
              {t(`error.${batch.error}`) === `error.${batch.error}`
                ? t('downloads.failedGeneric')
                : t(`error.${batch.error}`)}
            </span>
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                await send('/api/downloads/batches', 'POST', {
                  id: batch.id,
                  action: 'retry',
                }).catch(() => undefined);
                setRetrying(false);
              }}
              className="bg-fg text-bg h-9 rounded-full px-4 text-[13px] font-semibold"
            >
              {t('downloads.retry')}
            </button>
          </div>
        ) : (
          <ol
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1 md:ml-auto"
            aria-label={t('downloads.steps')}
          >
            {STEPS.map((s, i) => (
              <li
                key={s}
                aria-current={i === step ? 'step' : undefined}
                className={cx(
                  'flex items-center gap-1.5 font-serif text-[15px] italic md:text-[17px]',
                  i <= step ? 'text-fg' : 'text-faint',
                )}
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    background:
                      i < step || step === 3
                        ? 'var(--color-ok)'
                        : i === step
                          ? '#7aa2ff'
                          : '#3a3632',
                  }}
                />
                {t(`downloads.step.${s}`)}
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="bg-line-strong ml-1 h-px w-4" />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {items.length > 0 && (
        <ul className="border-line flex flex-col border-t">
          {items.map((q) => (
            <li
              key={q.chapter.id}
              className="border-line relative flex h-[42px] items-center gap-3.5 border-b px-3 text-sm"
            >
              <span
                className="absolute inset-y-0 left-0 bg-[#7aa2ff]/[0.16]"
                style={{ width: `${Math.round(q.progress * 100)}%` }}
              />
              <span className="relative w-[130px] truncate font-serif text-[19px]">
                {q.chapter.name}
              </span>
              <span className="relative ml-auto text-[13px]">
                {q.state === 'DOWNLOADING'
                  ? t('downloads.percent', { n: Math.round(q.progress * 100) })
                  : q.state === 'ERROR'
                    ? t('downloads.itemError')
                    : t('downloads.waiting')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
