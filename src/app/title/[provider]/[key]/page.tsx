'use client';
import { MediaLink } from '@/components/media-link';
import { LoadNotice } from '@/components/load-notice';
import { Select } from '@/components/select';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
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
import { batchesInterval, libraryKeys, openStream, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { rankSourceCandidates } from '@/lib/client/source-ranking';
import { Backdrop } from '@/components/backdrop';
import { ChapterTable, isMissing, preferredVariant } from '@/components/chapters';
import { PosterCard } from '@/components/media';
import { InfoBubble, Notice, toast } from '@/components/notify';
import { clearPersistentCache } from '@/lib/client/cache';
import { MatchesDrawer, MatchesSummary, type Lane, type Section } from '@/components/matches';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import { FavoriteButton } from '@/components/favorite';
import { OwnedInventory } from '@/components/owned-inventory';
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
  const detail = useApi<MediaDetail>(`/api/media?id=${encodeURIComponent(id)}`, {
    revalidateOnMount: true,
    dedupingInterval: 1000,
    refreshInterval: (data) => (data?.pending ? 1500 : 0),
  });
  if (detail.error && !detail.data)
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
  return (
    <Title
      key={id}
      media={{
        ...detail.data,
        pending: !detail.error && (detail.isValidating || detail.data.pending),
        partial: detail.data.partial || Boolean(detail.error),
      }}
    />
  );
}

function Title({ media }: { media: MediaDetail }) {
  const { t, n, language } = useI18n();
  const { mutate: mutateShared } = useSWRConfig();
  const [inventoryBusy, setInventoryBusy] = useState(false);
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
  const [scanFailed, setScanFailed] = useState(false);
  const [scanQuery, setScanQuery] = useState<string | null>(null);
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

  const shouldScan = useEffectEvent(() => needsMatch || matchRun > 0);
  const libraryReady = library.data !== undefined;
  useEffect(() => {
    if (!libraryReady || !shouldScan()) return;
    const failScan = () => {
      setScanFailed(true);
      setLanes((ls) =>
        (ls ?? []).map((l) => (l.state === 'loading' ? { ...l, state: 'error' } : l)),
      );
    };
    const close = openStream(
      `/api/media/sources?id=${encodeURIComponent(media.id)}${scanQuery ? `&q=${encodeURIComponent(scanQuery)}` : ''}`,
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
        linked: () => {
          void mutateShared(libraryKeys);
        },
        done: () => {
          void mutateShared(libraryKeys);
        },
        error: failScan,
      },
      failScan,
    );
    return close;
  }, [libraryReady, matchRun, media.id, scanQuery, language, mutateShared]);

  // A custom query (Matches → Sources search box) replaces the work's titles for the scan.
  const rescan = useCallback((q?: string) => {
    setScanFailed(false);
    setScanQuery(q?.trim() || null);
    setLanes(null);
    setMatchRun((r) => r + 1);
  }, []);

  const autoPicked = useMemo(
    () =>
      // Up to three confident sources: relevance, interface language, then completeness.
      (lanes ?? [])
        .filter((l) => l.candidates[0]?.score >= 0.9)
        .sort((a, b) => rankSourceCandidates(a.candidates[0], b.candidates[0], language))
        .slice(0, 3)
        .map((l) => ({
          suwayomiMangaId: l.candidates[0].suwayomiMangaId,
          sourceId: l.source.id,
          sourceName: l.source.name,
        })),
    [lanes, language],
  );
  const sources = override ?? stored ?? (fromDetail.length ? fromDetail : autoPicked);
  // Something needs a look: no source, or none could be found automatically.
  const attention = isComic && Boolean(entry) && sources.length === 0;
  const priority = sources.map((s) => s.sourceId);
  const chaptersKey =
    isComic && (sources.length || entry)
      ? [
          'chapters',
          media.id,
          JSON.stringify(sources),
          entry?.ownedAsVolumes,
          entry?.ownedVolumes?.join(','),
        ]
      : null;
  const chapters = useSWR<ChaptersResponse>(
    chaptersKey,
    () =>
      send<ChaptersResponse>('/api/manga/chapters', 'POST', {
        sources,
        mediaId: media.id,
        progressive: true,
      }),
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      refreshInterval: (data) => (data?.pending ? 750 : 0),
      dedupingInterval: 500,
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
  const ownedVolumes = new Set(entry?.ownedVolumes ?? chapters.data?.ownedVolumes ?? []);
  const missing = (chapters.data?.chapters ?? []).filter((c) => isMissing(c, owned, ownedVolumes));
  const matching =
    !scanFailed &&
    (lanes === null ? needsMatch || matchRun > 0 : lanes.some((l) => l.state === 'loading'));
  const checking =
    matching || chapters.isLoading || chapters.isValidating || Boolean(chapters.data?.pending);
  const incomplete = Boolean(
    scanFailed ||
    chapters.error ||
    chapters.data?.errors.length ||
    lanes?.some((l) => l.state === 'error'),
  );
  // Catalogs often lag behind: the real count is the highest of catalog, sources and library.
  const sourceMax = Math.max(0, ...(chapters.data?.chapters ?? []).map((c) => c.number ?? 0));
  const chapterReleased =
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
  const released =
    entry?.unit === 'volume' ? (entry.progress?.released ?? media.volumes) : chapterReleased;
  const progress = { ...baseProgress, released };
  // Works counted in volumes use "tome" wording for their progress.
  const vol = (key: string) => (entry?.unit === 'volume' ? `${key}Vol` : key);
  // Built-in reader: resume where the reader stopped, else the first unread chapter.
  const readTarget = (() => {
    const list = chapters.data?.chapters ?? [];
    const mediaId = encodeURIComponent(entry?.media.id ?? media.id);
    const pos = entry?.readerPosition;
    const retypedPosition = entry?.ownedAsVolumes && pos?.number != null && !owned.has(pos.number);
    const unavailableVolumePosition =
      pos?.chapterId && pos.chapterId < 0 && pos.number === null && !ownedVolumes.size;
    if (pos && !retypedPosition && !unavailableVolumePosition)
      return {
        href: `/read/${pos.chapterId}?media=${mediaId}`,
        label: pos.number !== null ? t('title.resumeAt', { n: n(pos.number) }) : t('title.resume'),
      };
    if (isComic && entry?.unit === 'volume') {
      const volume = [...ownedVolumes]
        .sort((a, b) => a - b)
        .find((v) => progress.read === null || v > progress.read);
      if (volume !== undefined)
        return {
          href: `/read/local-volume-${volume}?media=${mediaId}`,
          label: t('title.readVolume', { n: n(volume) }),
        };
    }
    const firstUnread = [...list]
      .filter(
        (c) => c.number !== null && (entry?.chapterRead == null || c.number > entry.chapterRead),
      )
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))[0];
    const v = firstUnread && preferredVariant(firstUnread, priority, choice[firstUnread.key]);
    if (firstUnread?.number != null && owned.has(firstUnread.number))
      return {
        href: `/read/local-${firstUnread.number}?media=${mediaId}`,
        label: t('title.readFrom', { n: n(firstUnread.number) }),
      };
    return v
      ? {
          href: `/read/${v.id}?media=${mediaId}`,
          label: t('title.readFrom', { n: n(firstUnread.number ?? 0) }),
        }
      : null;
  })();

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
      .filter((c) => keys.includes(c.key) && isMissing(c, owned, ownedVolumes))
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
        chapterReleased ? t('title.chaptersCount', { count: n(chapterReleased) }) : null,
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
      <AdultMark media={media} />
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
            priority
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
            <FavoriteButton media={media} entry={entry} className="self-start sm:self-auto" />
            {isComic && (
              <button
                type="button"
                disabled={busy || missing.length === 0}
                onClick={() => download(missing.map((c) => c.key))}
                className={primaryButton}
              >
                {missing.length
                  ? t('title.completeSeries', { count: missing.length })
                  : checking || (!chapters.data && sources.length > 0)
                    ? t('title.loadingChapters')
                    : incomplete
                      ? t('chapters.partialLabel')
                      : sources.length && chapters.data?.chapters.length
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
              className="h-12 justify-center gap-3 bg-white/[0.14] px-5 sm:justify-between"
            />
            <ReadButton
              bunko={readTarget}
              kavita={
                media.kavita?.url
                  ? {
                      href: media.kavita.url,
                      label: t('kavita.read', { n: media.kavita.chapters }),
                    }
                  : null
              }
            />
          </div>
          {entry && (
            <div className="flex max-w-[560px] flex-col gap-2">
              <ProgressBar progress={progress} className="h-1.5" />
              <span className="text-mid flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                <span>
                  {t(vol('title.read'), { n: progress.read !== null ? n(progress.read) : '—' })}
                </span>
                <OwnedInventory entry={entry} />
                <span>
                  {t(vol('title.released'), {
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

          <LoadNotice
            pending={media.pending || checking || library.isLoading}
            partial={media.partial || incomplete}
          />
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
                {!sources.length && !entry ? (
                  scanFailed ? (
                    <Notice
                      title={t('loading.partial')}
                      action={
                        <button type="button" className={smallButton} onClick={() => rescan()}>
                          {t('common.retry')}
                        </button>
                      }
                    />
                  ) : (
                    <NoSource lanes={lanes} onSearch={() => setDrawer('sources')} />
                  )
                ) : chapters.error && !chapters.data ? (
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
                    key={media.id}
                    onViewChange={async (volume) => {
                      if (!entry || (entry.unit === 'volume') === volume) return;
                      try {
                        await send('/api/tracked', 'PATCH', {
                          id: entry.id,
                          unit: volume ? 'volume' : 'chapter',
                        });
                        await mutateShared(libraryKeys);
                      } catch (e) {
                        toast({ tone: 'bad', text: errorText(t, e) });
                      }
                    }}
                    inventoryCorrection={
                      entry && ((entry.ownedChapterCount ?? 0) > 0 || entry.ownedAsVolumes)
                        ? {
                            active: Boolean(entry.ownedAsVolumes),
                            busy: inventoryBusy,
                            onCorrect: async () => {
                              setInventoryBusy(true);
                              try {
                                await send('/api/tracked', 'PATCH', {
                                  id: entry.id,
                                  ownedAsVolumes: !entry.ownedAsVolumes,
                                });
                                await mutateShared(libraryKeys);
                              } catch (e) {
                                toast({ tone: 'bad', text: errorText(t, e) });
                              } finally {
                                setInventoryBusy(false);
                              }
                            },
                          }
                        : undefined
                    }
                    pending={checking}
                    ownedVolumes={ownedVolumes}
                    mediaId={entry?.media.id ?? media.id}
                    defaultByVolume={entry?.unit === 'volume'}
                    chapters={chapters.data.chapters}
                    priority={priority}
                    read={entry?.chapterRead ?? null}
                    volumeRead={entry?.volumeRead ?? null}
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
              <MediaLink
                key={r.media.id}
                media={r.media}
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
              </MediaLink>
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

/** Lets the reader mark a work 18+ (or unmark a false positive); hidden with 18+ content off. */
function AdultMark({ media }: { media: MediaDetail }) {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const adult = Boolean(media.adult);
  async function set(value: boolean | null) {
    setBusy(true);
    try {
      await send('/api/media/adult', 'PATCH', { id: media.id, adult: value });
      clearPersistentCache();
      await mutate((key) => typeof key === 'string' && key !== '/api/settings', undefined, {
        revalidate: true,
      });
      toast({
        tone: 'ok',
        text: value === null ? t('adult.reset') : value ? t('adult.marked') : t('adult.unmarked'),
      });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-line flex flex-wrap items-center gap-3 border-t pt-5 text-sm">
      <span className="text-muted">{t('adult.label')}</span>
      <InfoBubble label={t('adult.label')}>{t('adult.info')}</InfoBubble>
      <span className="ml-auto flex items-center gap-2">
        {media.adultOverride != null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => set(null)}
            className="text-mid text-xs underline hover:text-white"
          >
            {t('adult.automatic')}
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={adult}
          aria-label={t('adult.label')}
          disabled={busy}
          onClick={() => set(!adult)}
          className={cx(
            'relative h-6 w-11 rounded-full transition-colors disabled:opacity-50',
            adult ? 'bg-fg' : 'bg-white/15',
          )}
        >
          <span
            className={cx(
              'absolute top-1 size-4 rounded-full transition-[left]',
              adult ? 'bg-bg left-6' : 'bg-fg left-1',
            )}
          />
        </button>
      </span>
    </div>
  );
}

/** One "Read" action: the built-in reader first, Kavita in the attached menu (or alone). */
function ReadButton({
  bunko,
  kavita,
}: {
  bunko: { href: string; label: string } | null;
  kavita: { href: string; label: string } | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!bunko && !kavita) return null;
  if (!bunko)
    return (
      <a href={kavita!.href} target="_blank" rel="noreferrer" className={cx(ghostButton, 'gap-2')}>
        {kavita!.label} ↗
      </a>
    );
  return (
    <div ref={box} className="relative flex">
      <Link
        href={bunko.href}
        className={cx(ghostButton, 'flex-1 gap-2', kavita && 'rounded-r-none pr-4')}
      >
        {bunko.label}
      </Link>
      {kavita && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-label={t('title.readOptions')}
            onClick={() => setOpen((o) => !o)}
            className={cx(ghostButton, 'rounded-l-none border-l border-white/10 px-3.5')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden
              className={cx('transition-transform', open && 'rotate-180')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {open && (
            <div className="absolute top-[calc(100%+6px)] right-0 z-30 flex min-w-full flex-col rounded-2xl bg-[#1c1a17] p-1 text-sm shadow-[0_18px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10">
              <Link
                href={bunko.href}
                className="rounded-xl px-3 py-2.5 whitespace-nowrap hover:bg-white/[0.08]"
              >
                {t('title.readInBunko')}
              </Link>
              <a
                href={kavita.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl px-3 py-2.5 whitespace-nowrap hover:bg-white/[0.08]"
              >
                {kavita.label} ↗
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
