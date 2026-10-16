'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
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
import { mediaHref, openStream, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Backdrop } from '@/components/backdrop';
import { ChapterTable, isMissing, preferredVariant } from '@/components/chapters';
import { PosterCard } from '@/components/media';
import { MatchPanel } from '@/components/relink';
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
  cx,
  errorText,
  firstSentence,
  ghostButton,
  primaryButton,
  smallButton,
  statusKey,
} from '@/components/ui';

const STATUSES: ReadingStatus[] = ['PLANNING', 'READING', 'PAUSED', 'COMPLETED', 'DROPPED'];
type Lane = { source: Source; state: 'loading' | 'done' | 'error'; candidates: SourceCandidate[] };

export default function TitlePage() {
  const { provider, key } = useParams<{ provider: string; key: string }>();
  const id = `${provider}:${decodeURIComponent(key)}`;
  const { t } = useI18n();
  const detail = useApi<MediaDetail>(`/api/media?id=${encodeURIComponent(id)}`);
  if (detail.error)
    return (
      <main className="mx-auto max-w-[1440px] px-4 pt-24 md:px-16 md:pt-32">
        <Empty title={t('title.unavailable')}>
          <ErrorNote error={detail.error} />
        </Empty>
      </main>
    );
  if (!detail.data)
    return (
      <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 pt-[300px] md:flex-row md:items-end md:gap-12 md:px-16 md:pt-[220px]">
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
  const { mutate } = useSWRConfig();
  const batches = useApi<DownloadBatch[]>('/api/downloads/batches', { refreshInterval: 4000 });
  const entry = (library.data ?? []).find(
    (e) =>
      e.media.id === media.id ||
      (media.anilistId !== null && e.anilistId === media.anilistId) ||
      (media.mangadexId !== null && e.mangadexId === media.mangadexId),
  );
  const [tab, setTab] = useState<'chapters' | 'sources' | 'info'>('chapters');
  const [override, setOverride] = useState<ChapterSelection[] | null>(null);
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [matchRun, setMatchRun] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
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

  const autoPicked = useMemo(
    () =>
      (lanes ?? [])
        .filter((l) => l.candidates[0]?.score >= 0.9)
        .slice(0, 2)
        .map((l) => ({
          suwayomiMangaId: l.candidates[0].suwayomiMangaId,
          sourceId: l.source.id,
          sourceName: l.source.name,
        })),
    [lanes],
  );
  const sources = override ?? stored ?? (fromDetail.length ? fromDetail : autoPicked);
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
    if (entry)
      await send('/api/tracked', 'PATCH', { id: entry.id, sources: next }).catch(() => undefined);
    void library.mutate();
  }
  async function setStatus(value: ReadingStatus | 'NONE') {
    setMessage(null);
    try {
      if (value === 'NONE') {
        if (entry) await send('/api/tracked', 'DELETE', { id: entry.id });
      } else if (entry) await send('/api/tracked', 'PATCH', { id: entry.id, status: value });
      else await send('/api/tracked', 'POST', { media, status: value, sources });
      await library.mutate();
    } catch (e) {
      setMessage({ tone: 'bad', text: errorText(t, e) });
    }
  }
  async function setAuto(on: boolean) {
    setMessage(null);
    try {
      if (entry) await send('/api/tracked', 'PATCH', { id: entry.id, autoDownload: on, sources });
      else
        await send('/api/tracked', 'POST', { media, status: 'READING', autoDownload: on, sources });
      await library.mutate();
    } catch (e) {
      setMessage({ tone: 'bad', text: errorText(t, e) });
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
    setMessage(null);
    try {
      if (!entry) await send('/api/tracked', 'POST', { media, status: 'READING', sources });
      for (let i = 0; i < ids.length; i += 500)
        await send('/api/downloads/enqueue', 'POST', { chapterIds: ids.slice(i, i + 500), media });
      setSelected(new Set());
      setMessage({ tone: 'ok', text: t('title.queued', { count: ids.length }) });
      await Promise.all([batches.mutate(), library.mutate()]);
    } catch (e) {
      setMessage({ tone: 'bad', text: errorText(t, e) });
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

  return (
    <main className="relative" style={{ ['--accent' as string]: media.color ?? '#9fb6ff' }}>
      <Backdrop
        image={media.bannerUrl}
        fallback={media.coverUrl}
        color={media.color ?? '#7aa2ff'}
        className="h-[440px] md:h-[780px]"
      />
      <section className="relative mx-auto flex max-w-[1440px] flex-col gap-4 px-4 pt-[150px] md:flex-row md:items-end md:gap-12 md:px-16 md:pt-[150px]">
        <div className="flex items-end gap-4 md:contents">
          <Cover src={media.coverUrl} alt={media.title} className="w-28 shrink-0 md:w-[250px]" />
          <div className="flex flex-col gap-2 md:hidden">
            <Kicker media={media} />
            <h1 className="font-display text-[40px] leading-[0.9] font-extrabold tracking-[-0.05em]">
              {media.title}
            </h1>
          </div>
        </div>
        <div className="flex max-w-[800px] flex-1 flex-col gap-4">
          <div className="hidden md:block">
            <Kicker media={media} />
          </div>
          <h1 className="font-display hidden text-[92px] leading-[0.9] font-extrabold tracking-[-0.05em] md:block">
            {media.title}
          </h1>
          {media.synopsis && (
            <p className="text-soft font-serif text-[19px] leading-snug italic md:text-[25px]">
              {t('common.quote', { text: firstSentence(media.synopsis) })}
            </p>
          )}
          <div className="flex flex-col gap-3 md:mt-1.5 md:flex-row md:items-center">
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
            <label className={cx(ghostButton, 'pr-2 pl-5')}>
              <Dot tone={entry ? 'accent' : 'idle'} />
              <select
                aria-label={t('title.readingStatus')}
                value={entry?.status ?? 'NONE'}
                onChange={(e) => setStatus(e.target.value as ReadingStatus | 'NONE')}
                className="h-10 flex-1 bg-transparent pr-2 text-[15px] text-white"
              >
                <option value="NONE">{t('title.notInLibrary')}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </select>
            </label>
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
            <div className="flex max-w-[520px] flex-col gap-2">
              <ProgressBar progress={progress} className="h-1.5" />
              <span className="text-mid flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                <span>
                  {t('title.read', { n: progress.read !== null ? n(progress.read) : '—' })}
                </span>
                <span>{t('title.owned', { n: n(progress.owned) })}</span>
                <span>
                  {t('title.released', {
                    n: progress.released !== null ? n(progress.released) : '—',
                  })}
                </span>
                <span className="text-muted">
                  {progress.readSource === 'kavita'
                    ? t('title.readFromKavita')
                    : t('title.readUnknown')}
                </span>
              </span>
            </div>
          )}
          {message && (
            <p
              role="status"
              className={cx('text-sm', message.tone === 'bad' ? 'text-bad' : 'text-ok')}
            >
              {message.text}{' '}
              {message.tone === 'ok' && (
                <Link href="/downloads" className="text-mid underline">
                  {t('title.seeDownloads')}
                </Link>
              )}
            </p>
          )}
        </div>
      </section>

      <div className="relative mx-auto mt-8 max-w-[1440px] px-4 md:hidden">
        <Segmented
          value={tab}
          onChange={setTab}
          label={t('title.sections')}
          items={[
            { id: 'chapters', label: isComic ? t('title.tab.chapters') : t('title.tab.reading') },
            { id: 'sources', label: t('title.tab.sources', { count: sources.length }) },
            { id: 'info', label: t('title.tab.info') },
          ]}
        />
      </div>

      <div className="relative mx-auto grid max-w-[1440px] gap-10 px-4 pt-5 pb-16 md:grid-cols-[320px_minmax(0,1fr)] md:gap-16 md:px-16 md:pt-14">
        <aside className="flex flex-col gap-8">
          <div className={cx('flex-col gap-8', tab === 'info' ? 'flex' : 'hidden md:flex')}>
            <dl className="flex flex-col text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="border-line flex justify-between gap-4 border-b py-2.5">
                  <dt className="text-muted shrink-0">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
            {media.synopsis && <Synopsis text={media.synopsis} />}
            {entry && (
              <MatchPanel
                entry={entry}
                media={media}
                onChanged={() =>
                  Promise.all([
                    library.mutate(),
                    mutate(`/api/media?id=${encodeURIComponent(media.id)}`),
                  ])
                }
              />
            )}
          </div>
          {isComic && (
            <div className={cx('flex-col gap-8', tab === 'sources' ? 'flex' : 'hidden md:flex')}>
              <SourcesPanel
                sources={sources}
                lanes={lanes}
                onChange={updateSources}
                onSearchAgain={() => {
                  setLanes(null);
                  setMatchRun((r) => r + 1);
                }}
                title={media.title}
              />
              <Automation entry={entry} disabled={!sources.length} onAuto={setAuto} />
            </div>
          )}
        </aside>
        <section
          aria-labelledby="toc"
          className={cx('min-w-0 flex-col gap-4', tab === 'chapters' ? 'flex' : 'hidden md:flex')}
        >
          {isComic ? (
            <>
              <SectionHeading
                id="toc"
                num={1}
                title={t('chapters.title')}
                aside={
                  chapters.data
                    ? t('chapters.aside', {
                        count: n(chapters.data.chapters.length),
                        sources: sources.length,
                      })
                    : undefined
                }
              />
              {!sources.length ? (
                <NoSource lanes={lanes} onSearch={() => setTab('sources')} title={media.title} />
              ) : chapters.error ? (
                <ErrorNote error={chapters.error} />
              ) : !chapters.data ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-11" />
                  ))}
                </div>
              ) : (
                <>
                  {chapters.data.errors.length > 0 && (
                    <p className="text-warn text-sm">
                      {t('chapters.partial', { count: chapters.data.errors.length })}
                    </p>
                  )}
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
                </>
              )}
            </>
          ) : (
            <Empty title={t('novel.title')}>{t('novel.body')}</Empty>
          )}
        </section>
      </div>

      {media.relations.length > 0 && (
        <section className="relative mx-auto flex max-w-[1440px] flex-col gap-5 px-4 pb-12 md:px-16">
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
        <section className="relative mx-auto flex max-w-[1440px] flex-col gap-5 px-4 pb-20 md:px-16">
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
          !open && 'line-clamp-6',
        )}
      >
        {text}
      </p>
      {text.length > 360 && (
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

function SourcesPanel({
  sources,
  lanes,
  onChange,
  onSearchAgain,
  title,
}: {
  sources: ChapterSelection[];
  lanes: Lane[] | null;
  onChange: (next: ChapterSelection[]) => void;
  onSearchAgain: () => void;
  title: string;
}) {
  const { t, n } = useI18n();
  const chosen = new Set(sources.map((s) => s.suwayomiMangaId));
  const others = (lanes ?? []).flatMap((l) =>
    l.candidates
      .filter((c) => !chosen.has(c.suwayomiMangaId))
      .map((c) => ({ ...c, sourceName: l.source.name })),
  );
  const pending = (lanes ?? []).filter((l) => l.state === 'loading').length;
  const move = (i: number, d: -1 | 1) => {
    const next = [...sources];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-muted text-xs tracking-[0.16em] uppercase">
          {t('sources.byPriority')}
        </span>
        <button
          type="button"
          onClick={onSearchAgain}
          className="text-mid text-[13px] hover:text-white"
        >
          {t('sources.searchAgain')}
        </button>
      </div>
      {sources.length === 0 && pending === 0 && (
        <p className="text-muted text-sm">{t('sources.noneChosen')}</p>
      )}
      <ol className="flex flex-col gap-2">
        {sources.map((s, i) => (
          <li
            key={`${s.sourceId}:${s.suwayomiMangaId}`}
            className={cx(
              'flex items-center gap-3 rounded-2xl px-3.5 py-3 text-sm',
              i === 0 ? 'bg-white/[0.07]' : 'bg-white/[0.04]',
            )}
          >
            <span className="text-muted w-4 font-serif text-xl">{n(i + 1)}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{s.sourceName}</span>
            </span>
            <span className="flex gap-0.5">
              <IconBtn
                label={t('sources.up')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                d="m6 15 6-6 6 6"
              />
              <IconBtn
                label={t('sources.down')}
                disabled={i === sources.length - 1}
                onClick={() => move(i, 1)}
                d="m6 9 6 6 6-6"
              />
              <IconBtn
                label={t('sources.remove')}
                onClick={() => onChange(sources.filter((_, j) => j !== i))}
                d="M6 6l12 12M18 6 6 18"
              />
            </span>
          </li>
        ))}
      </ol>
      {pending > 0 && (
        <p className="text-muted font-serif text-base italic">
          {t('sources.matching', { count: pending })}
        </p>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted mt-2 text-xs">{t('sources.otherMatches')}</span>
          {others.slice(0, 6).map((c) => (
            <button
              key={`${c.sourceId}:${c.suwayomiMangaId}`}
              type="button"
              onClick={() =>
                onChange([
                  ...sources,
                  {
                    suwayomiMangaId: c.suwayomiMangaId,
                    sourceId: c.sourceId,
                    sourceName: c.sourceName,
                  },
                ])
              }
              className="flex items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-white/[0.05]"
            >
              <Dot tone={c.score >= 0.9 ? 'ok' : 'warn'} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{c.sourceName}</span>
                <span className="text-muted truncate text-xs">{c.title}</span>
              </span>
              <span className="text-muted font-serif text-[15px] italic">
                {c.score >= 0.9 ? t('sources.exact') : t('sources.doubtful')}
              </span>
              <span aria-hidden className="text-mid">
                +
              </span>
            </button>
          ))}
        </div>
      )}
      <Link
        href={`/search?q=${encodeURIComponent(title)}`}
        className="text-mid text-[13px] hover:text-white"
      >
        {t('sources.searchManually')} →
      </Link>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  d,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  d: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-mid flex size-8 items-center justify-center rounded-full hover:bg-white/[0.08] disabled:opacity-25"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden
      >
        <path d={d} />
      </svg>
    </button>
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

function NoSource({
  lanes,
  onSearch,
  title,
}: {
  lanes: Lane[] | null;
  onSearch: () => void;
  title: string;
}) {
  const { t } = useI18n();
  const engine = useSuwayomi();
  const pending = (lanes ?? []).filter((l) => l.state === 'loading').length;
  if (engine.state && engine.state !== 'ok') return <SuwayomiNotice />;
  if (lanes === null || pending > 0)
    return <p className="text-muted font-serif text-xl italic">{t('sources.matchingLong')}</p>;
  return (
    <Empty
      title={lanes.length === 0 ? t('sources.noSourcesInstalled') : t('sources.notFound')}
      action={
        <div className="flex flex-wrap gap-2">
          {lanes.length === 0 ? (
            <Link href="/sources" className={smallButton}>
              {t('sources.manage')}
            </Link>
          ) : (
            <>
              <button type="button" onClick={onSearch} className={cx(smallButton, 'md:hidden')}>
                {t('sources.seeCandidates')}
              </button>
              <Link href={`/search?q=${encodeURIComponent(title)}`} className={smallButton}>
                {t('sources.searchManually')}
              </Link>
            </>
          )}
        </div>
      }
    >
      {lanes.length === 0 ? t('sources.noSourcesBody') : t('sources.notFoundBody')}
    </Empty>
  );
}
