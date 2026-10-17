'use client';
import { Select } from '@/components/select';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import type {
  ChapterSelection,
  ChaptersResponse,
  DownloadBatch,
  MediaDetail,
  ReadingStatus,
  Source,
  SourceCandidate,
  TrackedMedia,
} from '@/types/shared';
import { batchesInterval, mediaHref, openStream, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Backdrop } from '@/components/backdrop';
import { ChapterTable, isMissing, preferredVariant } from '@/components/chapters';
import { PosterCard } from '@/components/media';
import { InfoBubble, Notice, toast } from '@/components/notify';
import { MatchesDrawer, MatchesSummary, type Lane, type Section } from '@/components/matches';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import {
  Cover,
  Dot,
  Empty,
  ErrorNote,
  ProgressBar,
  SectionHeading,
  Segmented,
  Skeleton,
  Spinner,
  cx,
  errorText,
  ghostButton,
  primaryButton,
  smallButton,
  statusKey,
} from '@/components/ui';

const STATUSES: ReadingStatus[] = ['PLANNING', 'READING', 'PAUSED', 'COMPLETED', 'DROPPED'];

export default function TitlePage() {
  const { provider, key } = useParams<{ provider: string; key: string }>();
  const id = `${provider}:${decodeURIComponent(key)}`;
  const { t } = useI18n();
  const detail = useApi<MediaDetail>(`/api/media?id=${encodeURIComponent(id)}`);
  if (detail.error)
    return (
      <main className="mx-auto max-w-[1760px] px-4 pt-24 md:px-10 md:pt-32">
        <Empty title={t('title.unavailable')}>
          <ErrorNote error={detail.error} />
        </Empty>
      </main>
    );
  if (!detail.data)
    return (
      <main className="mx-auto flex max-w-[1760px] flex-col gap-4 px-4 pt-[300px] md:flex-row md:items-end md:gap-12 md:px-10 md:pt-[220px]">
        <Skeleton className="aspect-[2/3] w-28 md:w-[250px]" />
        <div className="flex flex-1 flex-col gap-4">
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-14 w-3/4 md:h-20" />
          <Skeleton className="h-6 w-1/2" />
        </div>
      </main>
    );
  return <Title media={detail.data} />;
}

function Title({ media }: { media: MediaDetail }) {
  const { t, n } = useI18n();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const batches = useApi<DownloadBatch[]>('/api/downloads/batches', {
    refreshInterval: batchesInterval,
  });
  const entry = (library.data ?? []).find(
    (e) =>
      e.media.id === media.id ||
      (media.anilistId !== null && e.anilistId === media.anilistId) ||
      (media.mangadexId !== null && e.mangadexId === media.mangadexId),
  );
  const [tab, setTab] = useState<'chapters' | 'info'>('chapters');
  const [drawer, setDrawer] = useState<Section | null>(null);
  const [override, setOverride] = useState<ChapterSelection[] | null>(null);
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [matchRun, setMatchRun] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const isComic = media.type === 'MANGA';
  const fromDetail: ChapterSelection[] = media.sources.map((s) => ({
    suwayomiMangaId: s.suwayomiMangaId,
    sourceId: s.sourceId,
    sourceName: s.sourceName,
  }));
  const stored = entry?.sources.length ? entry.sources : null;
  const needsMatch = isComic && !stored && fromDetail.length === 0 && library.data !== undefined;

  useEffect(() => {
    if (!needsMatch && matchRun === 0) return;
    const close = openStream(
      `/api/media/sources?id=${encodeURIComponent(media.id)}`,
      {
        sources: (d) =>
          setLanes(
            (d as { sources: Source[] }).sources.map((source) => ({
              source,
              state: 'loading',
              candidates: [],
            })),
          ),
        match: (d) => {
          const m = d as { source: Source; candidates: SourceCandidate[] };
          setLanes((ls) =>
            (ls ?? []).map((l) =>
              l.source.id === m.source.id ? { ...l, state: 'done', candidates: m.candidates } : l,
            ),
          );
        },
        source_error: (d) => {
          const e = d as { source: Source };
          setLanes((ls) =>
            (ls ?? []).map((l) => (l.source.id === e.source.id ? { ...l, state: 'error' } : l)),
          );
        },
        done: () => undefined,
      },
      () =>
        setLanes((ls) =>
          (ls ?? []).map((l) => (l.state === 'loading' ? { ...l, state: 'error' } : l)),
        ),
    );
    return close;
  }, [needsMatch, matchRun, media.id]);

  const rescan = useCallback(() => {
    setLanes(null);
    setMatchRun((r) => r + 1);
  }, []);

  const autoPicked = useMemo(
    () =>
      // Up to three confident sources: most relevant first, then the most complete.
      (lanes ?? [])
        .filter((l) => l.candidates[0]?.score >= 0.9)
        .sort(
          (a, b) =>
            b.candidates[0].score - a.candidates[0].score ||
            (b.candidates[0].chapterCount ?? 0) - (a.candidates[0].chapterCount ?? 0),
        )
        .slice(0, 3)
        .map((l) => ({
          suwayomiMangaId: l.candidates[0].suwayomiMangaId,
          sourceId: l.source.id,
          sourceName: l.source.name,
        })),
    [lanes],
  );
  const sources = override ?? stored ?? (fromDetail.length ? fromDetail : autoPicked);
  // Something needs a look: no source, or none could be found automatically.
  const attention = isComic && Boolean(entry) && sources.length === 0;
  const priority = sources.map((s) => s.sourceId);
  const chaptersKey = isComic && sources.length ? ['chapters', JSON.stringify(sources)] : null;
  const chapters = useSWR<ChaptersResponse>(
    chaptersKey,
    () => send<ChaptersResponse>('/api/manga/chapters', 'POST', { sources, mediaId: media.id }),
    {
      revalidateOnFocus: false,
    },
  );
  const active = (batches.data ?? []).filter(
    (b) =>
      b.media.id === (entry?.media.id ?? media.id) && !['completed', 'error'].includes(b.state),
  );
  const queued = new Set(
    active.flatMap((b) => b.chapterIds.filter((cid) => !b.importedIds.includes(cid))),
  );
  const owned = new Set(chapters.data?.inKavita ?? []);
  const missing = (chapters.data?.chapters ?? []).filter((c) => isMissing(c, owned));
  // Catalogs often lag behind: the real count is the highest of catalog, sources and library.
  const sourceMax = Math.max(0, ...(chapters.data?.chapters ?? []).map((c) => c.number ?? 0));
  const released =
    Math.max(
      media.chapters ?? 0,
      sourceMax,
      entry?.progress?.released ?? 0,
      ...(chapters.data?.inKavita ?? [0]),
    ) || null;
  const baseProgress = entry?.progress ?? {
    read: null,
    owned: 0,
    released: null,
    unread: 0,
    readSource: 'none' as const,
  };
  const progress = { ...baseProgress, released };

  async function updateSources(next: ChapterSelection[]) {
    setOverride(next);
    try {
      if (entry) await send('/api/tracked', 'PATCH', { id: entry.id, sources: next });
    } finally {
      void library.mutate();
    }
  }
  async function setStatus(value: ReadingStatus | 'NONE') {
    try {
      if (value === 'NONE') {
        if (entry) await send('/api/tracked', 'DELETE', { id: entry.id });
      } else if (entry) await send('/api/tracked', 'PATCH', { id: entry.id, status: value });
      else await send('/api/tracked', 'POST', { media, status: value, sources });
      await library.mutate();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    }
  }
  async function setAuto(on: boolean) {
    try {
      if (entry) await send('/api/tracked', 'PATCH', { id: entry.id, autoDownload: on, sources });
      else
        await send('/api/tracked', 'POST', { media, status: 'READING', autoDownload: on, sources });
      await library.mutate();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    }
  }
  async function download(keys: string[]) {
    const list = chapters.data?.chapters ?? [];
    const ids = list
      .filter((c) => keys.includes(c.key) && isMissing(c, owned))
      .map((c) => preferredVariant(c, priority, choice[c.key])?.id)
      .filter((v): v is number => typeof v === 'number' && !queued.has(v));
    if (!ids.length) return;
    setBusy(true);
    try {
      if (!entry) await send('/api/tracked', 'POST', { media, status: 'READING', sources });
      for (let i = 0; i < ids.length; i += 500)
        await send('/api/downloads/enqueue', 'POST', { chapterIds: ids.slice(i, i + 500), media });
      setSelected(new Set());
      toast({
        tone: 'ok',
        text: t('title.queued', { count: ids.length }),
        link: { href: '/downloads', label: t('title.seeDownloads') },
      });
      await Promise.all([batches.mutate(), library.mutate()]);
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }

  const facts = [
    [
      t('title.facts.format'),
      [
        media.format ? t(`format.${media.format}`) : t(`type.${media.type}`),
        media.origin && t(`origin.${media.origin}`) !== `origin.${media.origin}`
          ? t(`origin.${media.origin}`)
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    [
      t('title.facts.publication'),
      [
        media.status ? t(`status.${statusKey(media.status)}`) : null,
        released ? t('title.chaptersCount', { count: n(released) }) : null,
        media.volumes ? t('title.volumesCount', { count: n(media.volumes) }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    [t('title.facts.authors'), media.authors.slice(0, 3).join(', ')],
    [
      t('title.facts.genres'),
      media.genres
        .slice(0, 4)
        .map((g) => (t(`genre.${g}`) === `genre.${g}` ? g : t(`genre.${g}`)))
        .join(', '),
    ],
    [t('title.facts.score'), media.score !== null ? `${media.score} %` : ''],
    [
      t('title.facts.altTitles'),
      media.altTitles
        .filter((a) => a !== media.title)
        .slice(0, 2)
        .join(' · '),
    ],
  ].filter(([, v]) => v);

  const matchesButton = isComic && (
    <button
      type="button"
      onClick={() => setDrawer('catalog')}
      className={cx(ghostButton, 'w-full gap-2.5 bg-transparent ring-1 ring-white/25')}
    >
      <LinkIcon />
      {t('match.manage')}
      {attention && <Dot tone="warn" />}
    </button>
  );
  const details = (
    <>
      <dl className="flex flex-col text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="border-line flex justify-between gap-4 border-b py-2.5">
            <dt className="text-muted shrink-0">{k}</dt>
            <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      {media.synopsis && <Synopsis text={media.synopsis} />}
      {isComic && (
        <div className="flex flex-col gap-4">
          <MatchesSummary
            entry={entry}
            media={media}
            sources={sources}
            onOpen={(section) => setDrawer(section)}
          />
          {matchesButton}
          <Automation entry={entry} disabled={!sources.length} onAuto={setAuto} />
        </div>
      )}
    </>
  );

  return (
    <main className="relative" style={{ ['--accent' as string]: media.color ?? '#9fb6ff' }}>
      <Backdrop
        // Only the catalog work's own banner; none when detached, hidden, or missing.
        image={
          entry?.identity === 'off-catalog' || entry?.backdrop === 'hidden' ? null : media.bannerUrl
        }
        color={media.color ?? '#7aa2ff'}
        className="h-[440px] md:h-[720px]"
      />
      <div className="relative mx-auto grid max-w-[1760px] gap-6 px-4 pt-[110px] pb-16 md:grid-cols-[280px_minmax(0,1fr)] md:gap-12 md:px-10 md:pt-[150px] lg:grid-cols-[300px_minmax(0,1fr)] xl:gap-16">
        {/* Left: cover, then everything about the work. */}
        <aside className="hidden flex-col gap-7 self-start md:flex">
          <Cover
            src={entry?.coverUrl ?? media.coverUrl}
            fallbacks={entry?.coverFallbacks}
            alt={media.title}
            className="mx-auto w-full max-w-[300px]"
          />
          {details}
        </aside>

        {/* Right: title, actions, chapters. */}
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex items-end gap-4 md:block">
            <Cover
              src={entry?.coverUrl ?? media.coverUrl}
              fallbacks={entry?.coverFallbacks}
              alt=""
              className="w-24 shrink-0 md:hidden"
            />
            <div className="flex min-w-0 flex-col gap-2 md:gap-4">
              <Kicker media={media} />
              <h1 className="font-display text-[34px] leading-[0.92] font-extrabold tracking-[-0.05em] [overflow-wrap:anywhere] md:text-[56px] xl:text-[80px]">
                {media.title}
              </h1>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            {isComic && (
              <button
                type="button"
                disabled={busy || missing.length === 0}
                onClick={() => download(missing.map((c) => c.key))}
                className={primaryButton}
              >
                {chapters.isLoading || (!chapters.data && sources.length > 0)
                  ? t('title.loadingChapters')
                  : missing.length
                    ? t('title.completeSeries', { count: missing.length })
                    : sources.length
                      ? t('title.complete')
                      : t('title.noSource')}
              </button>
            )}
            <Select
              label={t('title.readingStatus')}
              value={entry?.status ?? 'NONE'}
              onChange={(v) => setStatus(v as ReadingStatus | 'NONE')}
              options={[
                { value: 'NONE', label: t('title.notInLibrary') },
                ...STATUSES.map((x) => ({ value: x, label: t(`status.${x}`) })),
              ]}
              size="lg"
              className="h-12 bg-white/[0.14] px-5"
            />
            {media.kavita?.url && (
              <a
                href={media.kavita.url}
                target="_blank"
                rel="noreferrer"
                className={cx(ghostButton, 'bg-transparent ring-1 ring-white/25')}
              >
                {t('kavita.read', { n: media.kavita.chapters })} ↗
              </a>
            )}
          </div>
          {entry && (
            <div className="flex max-w-[560px] flex-col gap-2">
              <ProgressBar progress={progress} className="h-1.5" />
              <span className="text-mid flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                <span>
                  {t('title.read', { n: progress.read !== null ? n(progress.read) : '—' })}
                </span>
                <span>{t('title.owned', { n: n(progress.owned) })}</span>
                <span>
                  {t('title.released', {
                    n: progress.released !== null ? n(progress.released) : '—',
                  })}
                </span>
                <InfoBubble label={t('title.progressInfo')}>
                  {progress.readSource === 'kavita'
                    ? t('title.readFromKavita')
                    : t('title.readUnknown')}
                </InfoBubble>
              </span>
            </div>
          )}

          <div className="mt-2 md:hidden">
            <Segmented
              value={tab}
              onChange={setTab}
              label={t('title.sections')}
              items={[
                {
                  id: 'chapters',
                  label: isComic ? t('title.tab.chapters') : t('title.tab.reading'),
                },
                { id: 'info', label: t('title.tab.info') },
              ]}
            />
          </div>
          <div className={cx('flex-col gap-7 md:hidden', tab === 'info' ? 'flex' : 'hidden')}>
            {details}
          </div>

          <section
            aria-labelledby="toc"
            className={cx(
              'min-w-0 flex-col gap-4 md:mt-6',
              tab === 'chapters' ? 'flex' : 'hidden md:flex',
            )}
          >
            {isComic ? (
              <>
                <SectionHeading
                  id="toc"
                  num={1}
                  title={t('chapters.title')}
                  aside={
                    chapters.data ? (
                      <span className="inline-flex items-center gap-2">
                        {t('chapters.aside', {
                          count: n(chapters.data.chapters.length),
                          sources: sources.length,
                        })}
                        {chapters.data.errors.length > 0 && (
                          <InfoBubble tone="warn" label={t('chapters.partialLabel')}>
                            {t('chapters.partial', { count: chapters.data.errors.length })}
                          </InfoBubble>
                        )}
                      </span>
                    ) : undefined
                  }
                />
                {!sources.length ? (
                  <NoSource lanes={lanes} onSearch={() => setDrawer('sources')} />
                ) : chapters.error ? (
                  <Notice
                    tone="bad"
                    title={t('chapters.loadFailed')}
                    action={
                      <button
                        type="button"
                        onClick={() => chapters.mutate()}
                        className={smallButton}
                      >
                        {t('common.retry')}
                      </button>
                    }
                  >
                    {errorText(t, chapters.error)}
                  </Notice>
                ) : !chapters.data ? (
                  <div className="flex flex-col gap-2">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-11" />
                    ))}
                  </div>
                ) : (
                  <ChapterTable
                    chapters={chapters.data.chapters}
                    priority={priority}
                    read={progress.read}
                    selected={selected}
                    setSelected={setSelected}
                    choice={choice}
                    setChoice={(k, v) => setChoice((c) => ({ ...c, [k]: v }))}
                    queued={queued}
                    owned={owned}
                  />
                )}
              </>
            ) : (
              <Empty title={t('novel.title')}>{t('novel.body')}</Empty>
            )}
          </section>
        </div>
      </div>

      {media.relations.length > 0 && (
        <section className="relative mx-auto flex max-w-[1760px] flex-col gap-5 px-4 pb-12 md:px-10">
          <SectionHeading num={2} title={t('title.universe')} />
          <div className="no-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            {media.relations.map((r) => (
              <Link
                key={r.media.id}
                href={mediaHref(r.media.id)}
                className="flex w-[300px] shrink-0 items-center gap-4 rounded-2xl bg-white/[0.04] p-3 hover:bg-white/[0.07]"
              >
                <Cover src={r.media.coverUrl} className="w-[64px] shrink-0" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="line-clamp-2 font-semibold">{r.media.title}</span>
                  <span className="text-muted font-serif text-[17px] italic">
                    {t(`relation.${r.relation}`) === `relation.${r.relation}`
                      ? t('relation.OTHER')
                      : t(`relation.${r.relation}`)}
                    {r.media.format ? ` · ${t(`format.${r.media.format}`)}` : ''}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {media.recommendations.length > 0 && (
        <section className="relative mx-auto flex max-w-[1760px] flex-col gap-5 px-4 pb-20 md:px-10">
          <SectionHeading
            num={media.relations.length ? 3 : 2}
            title={t('title.recommendations')}
            aside={t('title.recommendationsAside')}
          />
          <div className="no-scrollbar -mx-4 flex gap-3.5 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-6 md:gap-6 md:px-0 xl:grid-cols-8">
            {media.recommendations.slice(0, 8).map((m) => (
              <PosterCard key={m.id} media={m} className="w-28 shrink-0 md:w-auto" />
            ))}
          </div>
        </section>
      )}

      <MatchesDrawer
        open={drawer !== null}
        section={drawer ?? 'catalog'}
        onSection={setDrawer}
        onClose={() => setDrawer(null)}
        entry={entry}
        media={media}
        sources={sources}
        lanes={lanes}
        scanStarted={needsMatch || matchRun > 0}
        onScan={rescan}
        onSources={updateSources}
        onTrack={() => setStatus('PLANNING')}
      />
      {selected.size > 0 && (
        <div className="bg-fg text-bg fixed inset-x-3 bottom-24 z-30 mx-auto flex max-w-[760px] items-center gap-3 rounded-full py-2 pr-2 pl-5 shadow-[0_20px_40px_rgba(0,0,0,0.5)] md:bottom-6">
          <span className="font-semibold">{t('title.selected', { count: selected.size })}</span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-[#5b564f] text-sm underline"
          >
            {t('common.clear')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => download([...selected])}
            className="bg-bg text-fg ml-auto h-11 rounded-full px-6 font-semibold disabled:opacity-50"
          >
            {busy ? t('common.working') : t('title.download')}
          </button>
        </div>
      )}
    </main>
  );
}

function Kicker({ media }: { media: MediaDetail }) {
  const { t } = useI18n();
  const parts = [
    media.format ? t(`format.${media.format}`) : t(`type.${media.type}`),
    media.origin && t(`origin.${media.origin}`) !== `origin.${media.origin}`
      ? t(`origin.${media.origin}`)
      : null,
    media.year,
    media.status ? t(`status.${statusKey(media.status)}`) : null,
  ].filter(Boolean);
  return (
    <div className="text-soft flex items-center gap-3 text-[10px] tracking-[0.16em] uppercase md:text-xs">
      <span
        className="hidden h-[3px] w-6 rounded-full md:block"
        style={{ background: 'var(--accent)' }}
      />
      {parts.join(' · ')}
    </div>
  );
}

function Synopsis({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted text-xs tracking-[0.16em] uppercase">{t('title.synopsis')}</span>
      <p
        className={cx(
          'text-mid text-sm leading-relaxed whitespace-pre-line',
          !open && 'line-clamp-3',
        )}
      >
        {text}
      </p>
      {text.length > 160 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-fg self-start text-sm underline"
        >
          {open ? t('common.less') : t('common.readMore')}
        </button>
      )}
    </div>
  );
}

function Automation({
  entry,
  disabled,
  onAuto,
}: {
  entry: TrackedMedia | undefined;
  disabled: boolean;
  onAuto: (on: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted mb-2 text-xs tracking-[0.16em] uppercase">
        {t('title.automation')}
      </span>
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
        {t('title.autoDownload')}
        <input
          type="checkbox"
          disabled={disabled}
          checked={entry?.autoDownload ?? false}
          onChange={(e) => onAuto(e.target.checked)}
          className="size-[18px] accent-[var(--accent)]"
        />
      </label>
      <p className="text-muted text-xs leading-relaxed">
        {disabled ? t('title.autoNeedsSource') : t('title.autoHint')}
      </p>
    </div>
  );
}

function NoSource({ lanes, onSearch }: { lanes: Lane[] | null; onSearch: () => void }) {
  const { t } = useI18n();
  const engine = useSuwayomi();
  const pending = (lanes ?? []).filter((l) => l.state === 'loading').length;
  if (engine.state && engine.state !== 'ok') return <SuwayomiNotice />;
  if (lanes === null || pending > 0)
    return (
      <p className="text-mid flex items-center gap-2 text-sm">
        <Spinner />
        {t('sources.matchingLong')}
      </p>
    );
  return (
    <Notice
      title={lanes.length === 0 ? t('sources.noSourcesInstalled') : t('sources.notFound')}
      action={
        lanes.length === 0 ? (
          <Link href="/sources" className={smallButton}>
            {t('sources.manage')}
          </Link>
        ) : (
          <button type="button" onClick={onSearch} className={smallButton}>
            {t('sources.seeCandidates')}
          </button>
        )
      }
    >
      {lanes.length === 0 ? t('sources.noSourcesBody') : t('sources.notFoundBody')}
    </Notice>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
