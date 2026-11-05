'use client';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  MediaRelease,
  MediaRequestState,
  MediaSearchTarget,
  UnifiedMedia,
} from '@/types/shared';
import { api, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from './select';
import { toast } from './notify';
import { Cover, Spinner, cx, errorText, ghostButton } from './ui';

const DOWNLOAD_ICON = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />
  </svg>
);

/**
 * A series, anime or film: "Download" (nothing on disk yet) or "Complete" (some of it), opening
 * the interactive search. Bunko never searches on its own: every release is chosen by hand.
 */
export function MediaDownload({ media }: { media: UnifiedMedia }) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  const state = useApi<MediaRequestState>(
    `/api/arr/request?mediaId=${encodeURIComponent(media.id)}`,
    {
      refreshInterval: (d) => (d?.state === 'downloading' ? 5000 : 0),
    },
  );
  const s = state.data;
  const arrReady = Boolean(s?.service && s.configured);
  if (!s || (!arrReady && !s.prowlarr)) return null;
  const percent = s.progress != null ? Math.round(s.progress * 100) : null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(ghostButton, 'gap-2', s.state === 'downloading' && 'min-w-[200px]')}
      >
        {s.state === 'downloading' ? (
          <span className="flex w-full flex-col gap-1.5 text-left text-sm">
            <span className="flex items-center justify-between gap-3">
              <span>{t('arr.downloading')}</span>
              <span className="text-mid tabular-nums">
                {percent !== null ? `${n(percent)} %` : ''}
              </span>
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-white/10">
              <span
                className={cx(
                  'block h-full rounded-full bg-[var(--accent)] transition-[width] duration-500',
                  percent === null && 'w-1/3 animate-pulse',
                )}
                style={percent !== null ? { width: `${Math.max(3, percent)}%` } : undefined}
              />
            </span>
          </span>
        ) : (
          <>
            {s.state === 'available' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                aria-hidden
              >
                <path d="m5 12 5 5 9-10" />
              </svg>
            ) : (
              DOWNLOAD_ICON
            )}
            {s.state === 'available'
              ? t('arr.downloaded')
              : s.state === 'partial'
                ? t('arr.complete', { files: n(s.files ?? 0), total: n(s.total ?? 0) })
                : t('arr.download')}
          </>
        )}
      </button>
      {open && (
        <MediaSearchDialog
          media={media}
          arr={arrReady ? s.service! : null}
          prowlarr={Boolean(s.prowlarr)}
          onClose={() => {
            setOpen(false);
            void state.mutate();
          }}
        />
      )}
    </>
  );
}

type Sort = 'seeders' | 'size' | 'date' | 'quality';
const RESOLUTION_RANK: Record<string, number> = {
  '2160P': 5,
  '4K': 5,
  '1080P': 4,
  '720P': 3,
  '576P': 2,
  '480P': 1,
};

type Tab = 'arr' | 'prowlarr';
interface Pane {
  results: MediaRelease[] | null;
  loading: boolean;
  error: unknown;
  startedAt: number | null;
}

/** Seconds since a search started (indexers can take a while). */
function Elapsed({ since }: { since: number }) {
  const { n } = useI18n();
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-muted tabular-nums">
      · {n(Math.max(0, Math.round((now - since) / 1000)))} s
    </span>
  );
}

function MediaSearchDialog({
  media,
  arr,
  prowlarr,
  onClose,
}: {
  media: UnifiedMedia;
  arr: 'sonarr' | 'radarr' | null;
  prowlarr: boolean;
  onClose: () => void;
}) {
  const { t, n } = useI18n();
  const film = media.format === 'MOVIE' || media.format === 'ANIMATION_FILM';
  const [tab, setTab] = useState<'arr' | 'prowlarr'>(arr ? 'arr' : 'prowlarr');
  const [target, setTarget] = useState<MediaSearchTarget | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const suggestions = useMemo(() => {
    const names = [media.title, ...media.altTitles].filter(
      (x, i, all) => x && all.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i,
    );
    const list = names.slice(0, 5);
    if (film && media.year) list.splice(1, 0, `${media.title} ${media.year}`);
    return list;
  }, [media, film]);
  const [query, setQuery] = useState(suggestions[0] ?? media.title);
  // Each tab keeps its own results: going to Prowlarr and back loses nothing.
  // Opening on the Sonarr/Radarr tab starts by preparing the work there.
  const [panes, setPanes] = useState<Record<Tab, Pane>>({
    arr: { results: null, loading: Boolean(arr), error: null, startedAt: null },
    prowlarr: { results: null, loading: false, error: null, startedAt: null },
  });
  const patch = (which: Tab, next: Partial<Pane>) =>
    setPanes((x) => ({ ...x, [which]: { ...x[which], ...next } }));
  const { results, loading, error, startedAt } = panes[tab];
  // A season search shows season packs; single episodes on demand.
  const [packsOnly, setPacksOnly] = useState(true);
  const [kind, setKind] = useState<'all' | 'tv' | 'movie'>('all');
  const searches = useRef<Record<Tab, AbortController | null>>({ arr: null, prowlarr: null });
  useEffect(
    () => () => {
      // Closing the window stops the searches still running.
      searches.current.arr?.abort();
      searches.current.prowlarr?.abort();
    },
    [],
  );
  const [sort, setSort] = useState<Sort>('seeders');
  const [filter, setFilter] = useState('');
  const [sent, setSent] = useState<Record<string, 'sending' | 'sent' | 'error'>>({});

  // Sonarr/Radarr tab: the work must be in the service first (added unmonitored, no search).
  function prepare() {
    send<MediaSearchTarget>('/api/arr/prepare', 'POST', { mediaId: media.id })
      .then((next) => {
        setTarget(next);
        // The first season with something missing (specials last).
        const missing = next.seasons.find((x) => x.number > 0 && x.files < x.episodes);
        setSeason(
          next.service === 'sonarr' ? ((missing ?? next.seasons[0])?.number ?? null) : null,
        );
        // A film has nothing to choose: its interactive search starts right away.
        if (next.service === 'radarr') return search('arr', null);
        patch('arr', { loading: false });
      })
      .catch((e) => patch('arr', { error: e, loading: false }));
  }
  useEffect(() => {
    if (arr) prepare();
    // Once, when the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(where: Tab, seasonNumber: number | null, q = query) {
    searches.current[where]?.abort();
    const controller = new AbortController();
    searches.current[where] = controller;
    patch(where, { loading: true, error: null, results: null, startedAt: Date.now() });
    try {
      const params = new URLSearchParams(
        where === 'prowlarr'
          ? { service: 'prowlarr', q, kind }
          : {
              mediaId: media.id,
              ...(seasonNumber !== null ? { season: String(seasonNumber) } : {}),
            },
      );
      // Indexers are slow (a minute or more is common): wait up to 10 minutes.
      const found = await api<MediaRelease[]>(`/api/arr/search?${params}`, {
        signal: controller.signal,
        timeoutMs: 600_000,
      });
      patch(where, { results: found, loading: false });
    } catch (e) {
      if (controller.signal.aborted) return;
      patch(where, { error: e, loading: false });
    }
  }

  async function take(r: MediaRelease) {
    setSent((x) => ({ ...x, [r.guid]: 'sending' }));
    try {
      await send('/api/arr/grab', 'POST', {
        mediaId: media.id,
        title: media.title,
        coverUrl: media.coverUrl,
        service: r.service,
        guid: r.guid,
        indexerId: r.indexerId,
        releaseTitle: r.title,
        size: r.size ? Math.round(r.size) : null,
      });
      setSent((x) => ({ ...x, [r.guid]: 'sent' }));
      toast({ tone: 'ok', text: t('arr.sent', { service: t(`settings.service.${r.service}`) }) });
    } catch (e) {
      setSent((x) => ({ ...x, [r.guid]: 'error' }));
      toast({ tone: 'bad', text: errorText(t, e) });
    }
  }

  const sonarrSeason = tab === 'arr' && target?.service === 'sonarr';
  const seasonPacks = sonarrSeason && packsOnly;
  const episodesHidden = seasonPacks ? (results ?? []).filter((r) => !r.fullSeason).length : 0;
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (results ?? [])
      .filter((r) => !seasonPacks || r.fullSeason)
      .filter((r) => words.every((w) => `${r.title} ${r.indexer}`.toLowerCase().includes(w)))
      .sort((a, b) =>
        sort === 'size'
          ? b.size - a.size
          : sort === 'date'
            ? (b.publishDate ?? '').localeCompare(a.publishDate ?? '')
            : sort === 'quality'
              ? (RESOLUTION_RANK[b.resolution ?? ''] ?? 0) -
                  (RESOLUTION_RANK[a.resolution ?? ''] ?? 0) || (b.seeders ?? 0) - (a.seeders ?? 0)
              : (b.seeders ?? -1) - (a.seeders ?? -1),
      );
  }, [results, filter, sort, seasonPacks]);

  const size = (bytes: number) =>
    bytes >= 1024 ** 3
      ? t('arr.gb', { n: n(Math.round((bytes / 1024 ** 3) * 10) / 10) })
      : t('arr.mb', { n: n(Math.round(bytes / 1024 ** 2)) });
  const age = (date: string | null) => {
    if (!date) return null;
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86400_000));
    return days < 1 ? t('arr.today') : t('arr.days', { n: n(days) });
  };
  const serviceName = (s: string) => t(`settings.service.${s}`);
  const seasonName = (x: number) => (x === 0 ? t('arr.specials') : t('arr.season', { n: n(x) }));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="bg-bg border-line fixed inset-0 z-50 flex flex-col outline-none md:inset-auto md:top-1/2 md:left-1/2 md:h-[min(88dvh,920px)] md:w-[min(1080px,calc(100vw-48px))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl md:border">
          <header className="border-line flex items-center gap-3 border-b px-4 pt-[max(env(safe-area-inset-top),14px)] pb-3 md:px-6 md:pt-5">
            <Cover src={media.coverUrl} alt="" className="w-10 shrink-0 shadow-none" />
            <div className="flex min-w-0 flex-1 flex-col">
              <Dialog.Title className="font-display truncate text-lg font-bold md:text-xl">
                {media.title}
              </Dialog.Title>
              <Dialog.Description className="text-muted text-xs">
                {t('arr.searchTitle')}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t('common.close')}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.14]"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                aria-hidden
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </Dialog.Close>
          </header>

          <div className="flex flex-col gap-3 px-4 pt-3 md:px-6">
            {/* Sonarr/Radarr interactive search, or Prowlarr by name. */}
            <div className="flex rounded-full bg-white/[0.06] p-0.5 text-sm" role="tablist">
              {(
                [
                  [
                    'arr',
                    arr ? serviceName(arr) : film ? serviceName('radarr') : serviceName('sonarr'),
                    Boolean(arr),
                  ],
                  ['prowlarr', serviceName('prowlarr'), prowlarr],
                ] as const
              ).map(([id, label, enabled]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  disabled={!enabled}
                  onClick={() => {
                    setTab(id);
                    if (id === 'arr' && !target && !panes.arr.loading) {
                      patch('arr', { loading: true, error: null });
                      prepare();
                    }
                  }}
                  className={cx(
                    'h-9 flex-1 rounded-full px-4 transition-colors disabled:opacity-35',
                    tab === id ? 'bg-fg text-bg font-semibold' : 'text-mid hover:text-white',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'arr' && target?.service === 'sonarr' && (
              <div className="flex flex-wrap items-center gap-2">
                {/* Few seasons: chips; long series (One Piece…): one menu. */}
                {target.seasons.length > 8 ? (
                  <Select
                    label={t('arr.seasonLabel')}
                    value={season === null ? '' : String(season)}
                    onChange={(v) => {
                      setSeason(Number(v));
                      patch('arr', { results: null });
                    }}
                    options={target.seasons.map((x) => ({
                      value: String(x.number),
                      label: `${seasonName(x.number)} · ${n(x.files)}/${n(x.episodes)}`,
                    }))}
                  />
                ) : (
                  <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
                    {target.seasons.map((x) => (
                      <button
                        key={x.number}
                        type="button"
                        aria-pressed={season === x.number}
                        onClick={() => {
                          setSeason(x.number);
                          patch('arr', { results: null });
                        }}
                        className={cx(
                          'h-9 shrink-0 rounded-full px-3.5 text-[13px] whitespace-nowrap',
                          season === x.number
                            ? 'bg-white/[0.16] text-white'
                            : 'text-mid bg-white/[0.05] hover:text-white',
                        )}
                      >
                        {seasonName(x.number)}
                        <span className="text-muted ml-1.5 tabular-nums">
                          {n(x.files)}/{n(x.episodes)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  disabled={loading || season === null}
                  onClick={() => void search('arr', season)}
                  className="bg-fg text-bg h-9 rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
                >
                  {t('arr.searchSeason', { season: seasonName(season ?? 1) })}
                </button>
              </div>
            )}

            {tab === 'prowlarr' && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (query.trim()) void search('prowlarr', null);
                }}
              >
                <div className="flex flex-wrap gap-2 md:flex-nowrap">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label={t('arr.query')}
                    className="h-11 min-w-0 flex-1 basis-full rounded-full md:basis-auto bg-white/[0.07] px-4 text-[15px] outline-none focus:bg-white/[0.1]"
                  />
                  <Select
                    label={t('arr.category')}
                    value={kind}
                    onChange={(v) => setKind(v as 'all' | 'tv' | 'movie')}
                    options={(['all', 'tv', 'movie'] as const).map((x) => ({
                      value: x,
                      label: t(`arr.category.${x}`),
                    }))}
                    className="h-11 shrink-0"
                  />
                  <button
                    type="submit"
                    disabled={loading || !query.trim()}
                    className="bg-fg text-bg h-11 shrink-0 rounded-full px-5 text-sm font-semibold disabled:opacity-50"
                  >
                    {t('arr.searchButton')}
                  </button>
                </div>
                <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
                  {suggestions.map((x) => (
                    <button
                      key={x}
                      type="button"
                      onClick={() => setQuery(x)}
                      className={cx(
                        'h-8 max-w-[260px] shrink-0 truncate rounded-full px-3 text-[12px]',
                        query === x
                          ? 'bg-white/[0.16] text-white'
                          : 'text-mid bg-white/[0.05] hover:text-white',
                      )}
                    >
                      {x}
                    </button>
                  ))}
                </div>
              </form>
            )}

            {results && results.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-mid">{t('arr.results', { count: n(shown.length) })}</span>
                {sonarrSeason && (
                  <button
                    type="button"
                    aria-pressed={packsOnly}
                    onClick={() => setPacksOnly((x) => !x)}
                    className={cx(
                      'h-9 rounded-full px-3.5 text-[13px] whitespace-nowrap',
                      packsOnly
                        ? 'bg-white/[0.16] text-white'
                        : 'text-mid bg-white/[0.06] hover:text-white',
                    )}
                  >
                    {t('arr.packsOnly')}
                  </button>
                )}
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('arr.filter')}
                  className="h-9 min-w-[140px] flex-1 rounded-full bg-white/[0.06] px-3.5 text-[13px] outline-none md:max-w-[260px]"
                />
                <Select
                  label={t('catalog.sort')}
                  value={sort}
                  size="sm"
                  onChange={(v) => setSort(v as Sort)}
                  options={(['seeders', 'quality', 'size', 'date'] as Sort[]).map((x) => ({
                    value: x,
                    label: t(`arr.sort.${x}`),
                  }))}
                />
              </div>
            )}
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-6">
            {loading && (
              <div className="text-mid flex items-center gap-3 py-10 text-sm">
                <Spinner />
                {tab === 'arr' && !target ? t('arr.preparing') : t('arr.searching')}
                {startedAt && <Elapsed since={startedAt} />}
              </div>
            )}
            {error ? <p className="text-bad py-6 text-sm">{errorText(t, error)}</p> : null}
            {!loading && !error && results === null && tab === 'prowlarr' && (
              <p className="text-muted py-6 text-sm">{t('arr.prowlarrHint')}</p>
            )}
            {!loading && results?.length === 0 && (
              <p className="text-muted py-6 font-serif text-lg italic">{t('arr.noResults')}</p>
            )}
            {!loading &&
              results &&
              results.length > 0 &&
              shown.length === 0 &&
              episodesHidden > 0 && (
                <p className="text-mid flex flex-wrap items-center gap-3 py-6 text-sm">
                  {t('arr.noPacks')}
                  <button
                    type="button"
                    onClick={() => setPacksOnly(false)}
                    className="underline underline-offset-4 hover:text-white"
                  >
                    {t('arr.showEpisodes', { count: n(episodesHidden) })}
                  </button>
                </p>
              )}
            <ul className="flex flex-col gap-2">
              {shown.map((r) => {
                const state = sent[r.guid];
                return (
                  <li
                    key={`${r.indexerId}:${r.guid}`}
                    className={cx(
                      'flex flex-col gap-2.5 rounded-2xl bg-white/[0.04] p-3.5 md:flex-row md:items-center md:gap-4',
                      state === 'sent' && 'ring-ok/50 ring-1',
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <span className="text-[13px] leading-snug font-medium [overflow-wrap:anywhere]">
                        {r.title}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {r.quality && <Badge strong>{r.quality}</Badge>}
                        {r.codec && <Badge>{r.codec}</Badge>}
                        {r.languages.map((l) => (
                          <Badge key={l} accent>
                            {l}
                          </Badge>
                        ))}
                        {r.fullSeason && <Badge>{t('arr.fullSeason')}</Badge>}
                        {!r.fullSeason && r.episodes.length > 0 && (
                          <Badge>
                            {t('arr.episodes', {
                              list:
                                r.episodes.length > 3
                                  ? `${n(r.episodes[0])}–${n(r.episodes[r.episodes.length - 1])}`
                                  : r.episodes.map((x) => n(x)).join(', '),
                            })}
                          </Badge>
                        )}
                        <span className="text-muted">
                          {[r.indexer, age(r.publishDate)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {r.rejected && r.rejections.length > 0 && (
                        <span className="text-warn text-[11px] leading-snug">
                          {r.rejections.slice(0, 2).join(' · ')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 md:shrink-0">
                      <span className="flex flex-col text-right text-[12px] tabular-nums md:w-[92px]">
                        <span className="font-semibold">{r.size ? size(r.size) : '—'}</span>
                        {r.seeders !== null && (
                          <span className={cx(r.seeders > 0 ? 'text-ok' : 'text-bad')}>
                            ↑ {n(r.seeders)}
                            {r.leechers !== null && (
                              <span className="text-muted"> · ↓ {n(r.leechers)}</span>
                            )}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        disabled={state === 'sending' || state === 'sent'}
                        onClick={() => void take(r)}
                        className={cx(
                          'ml-auto inline-flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-semibold md:ml-0',
                          state === 'sent'
                            ? 'text-ok bg-white/[0.06]'
                            : 'bg-fg text-bg hover:opacity-90 disabled:opacity-60',
                        )}
                      >
                        {state === 'sending' ? <Spinner /> : state === 'sent' ? '✓' : DOWNLOAD_ICON}
                        {state === 'sent' ? t('arr.sentShort') : t('arr.take')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <footer className="border-line flex items-center gap-3 border-t px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] md:px-6 md:pb-4">
            {Object.values(sent).includes('sent') && (
              <Link
                href="/downloads"
                className="text-mid text-sm underline underline-offset-4 hover:text-white"
              >
                {t('arr.seeDownloads')}
              </Link>
            )}
            <Dialog.Close className="bg-fg text-bg ml-auto h-10 rounded-full px-5 text-sm font-semibold">
              {t('common.close')}
            </Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Badge({
  children,
  strong,
  accent,
}: {
  children: ReactNode;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <span
      className={cx(
        'rounded-md px-1.5 py-0.5 font-medium',
        strong
          ? 'bg-white/[0.14] text-white'
          : accent
            ? 'bg-[#2563eb]/25 text-[#bfdbfe]'
            : 'text-mid bg-white/[0.07]',
      )}
    >
      {children}
    </span>
  );
}
