'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type {
  ChapterSelection,
  CoverChoice,
  CoverOption,
  MediaDetail,
  TrackedMedia,
} from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { rankSourceCandidates } from '@/lib/client/source-ranking';
import { useRelativeTime } from './time';
import type { Lane } from '@/lib/client/use-source-scan';
import { CatalogPicker, KavitaPicker } from './relink';
import { Cover, Dot, Skeleton, Spinner, cx, primaryButton, smallButton } from './ui';

export type { Lane };
/** Sections of the work settings page (`/title/…/settings?s=`). */
export type Section = 'general' | 'catalog' | 'sources' | 'kavita' | 'cover';
export type Save =
  { state: 'saving' } | { state: 'saved' } | { state: 'error'; text: string } | null;

const searching = (e: TrackedMedia | undefined) =>
  e?.sourceMatch === 'queued' || e?.sourceMatch === 'searching';

/** Three independent links (catalog, sources, Kavita), each with its state; rows open the manager. */
export function MatchesSummary({
  entry,
  media,
  sources,
  href,
}: {
  entry: TrackedMedia | undefined;
  media: MediaDetail;
  sources: ChapterSelection[];
  /** Settings page link for one section. */
  href: (section: Section) => string;
}) {
  const { t, n } = useI18n();
  const latest = Math.max(0, ...(entry?.sourceStatus ?? []).map((s) => s.latestChapter ?? 0));
  const offCatalog =
    entry?.identity === 'off-catalog' || media.providers.every((p) => p === 'kavita');
  type Row = { key: Section; label: string; value: ReactNode; tone: 'ok' | 'warn' | 'idle' };
  const rows: Row[] = [
    {
      key: 'catalog',
      label: t('match.catalog'),
      value: offCatalog
        ? t('match.offCatalogShort')
        : media.providers
            .filter((p) => p !== 'local' && p !== 'kavita')
            .map((p) => t(`provider.${p}`))
            .join(', ') || '—',
      tone: offCatalog ? 'idle' : 'ok',
    },
    {
      key: 'sources',
      label: t('match.sources'),
      value: sources.length ? (
        latest ? (
          t('match.sourcesValue', { count: sources.length, n: n(latest) })
        ) : (
          t('match.sourcesCount', { count: sources.length })
        )
      ) : searching(entry) ? (
        <span className="inline-flex items-center gap-2">
          <Spinner className="size-3" />
          {t('match.searchingBackground')}
        </span>
      ) : (
        t('match.noSource')
      ),
      tone: sources.length ? 'ok' : searching(entry) ? 'idle' : 'warn',
    },
    {
      key: 'kavita',
      label: 'Kavita',
      value: media.kavita
        ? entry?.ownedAsVolumes
          ? `${media.kavita.libraryName} · ${t('unit.volume')}`
          : t('match.kavitaShort', {
              library: media.kavita.libraryName,
              n: n(media.kavita.chapters),
            })
        : t('match.kavitaNone'),
      tone: media.kavita ? (entry?.kavitaCover?.state === 'failed' ? 'warn' : 'ok') : 'idle',
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted text-xs tracking-[0.16em] uppercase">{t('match.title')}</span>
      <div className="flex flex-col text-sm">
        {rows.map((r) => (
          <Link
            key={r.key}
            href={href(r.key)}
            className="border-line group flex items-center gap-3 border-b py-2.5 text-left"
          >
            <Dot tone={r.tone} />
            <span className="text-muted shrink-0">{r.label}</span>
            <span
              className={cx(
                'ml-auto flex min-w-0 items-center gap-2 text-right',
                r.tone === 'warn' && 'text-warn',
              )}
            >
              <span className="truncate">{r.value}</span>
              <span aria-hidden className="text-faint group-hover:text-fg">
                ›
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** One linked thing, shown the same way in every tab. */
export function Current({
  cover,
  title,
  detail,
  empty,
}: {
  cover?: string | null;
  title?: string;
  detail?: string;
  empty?: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-white/[0.05] p-3">
      {title ? (
        <>
          <Cover src={cover} className="w-12 shrink-0 shadow-none" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium">{title}</span>
            {detail && <span className="text-muted truncate text-sm">{detail}</span>}
          </span>
        </>
      ) : (
        <span className="text-warn text-sm">{empty}</span>
      )}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-mid text-sm leading-relaxed">{children}</p>;
}

/** The name Bunko shows for this work: catalog/Kavita names or a custom one. */
export function DisplayTitle({
  entry,
  onTitle,
}: {
  entry: TrackedMedia;
  onTitle: (title: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [custom, setCustom] = useState('');
  const names = [...new Set([entry.title, ...(entry.titleOptions ?? [])])];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted text-xs tracking-[0.14em] uppercase">
        {t('match.displayTitle')}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={entry.title === name}
            onClick={() => onTitle(name)}
            className={cx(
              'max-w-full truncate rounded-full px-3 py-1.5 text-sm',
              entry.title === name
                ? 'bg-fg text-bg font-semibold'
                : 'bg-white/[0.06] hover:bg-white/[0.1]',
            )}
          >
            {name}
          </button>
        ))}
        {entry.customTitle && (
          <button
            type="button"
            onClick={() => onTitle(null)}
            className="text-mid px-2 text-sm underline hover:text-white"
          >
            {t('match.titleAuto')}
          </button>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) void onTitle(custom.trim()).then(() => setCustom(''));
        }}
        className="flex gap-2"
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={t('match.titleCustom')}
          aria-label={t('match.titleCustom')}
          maxLength={300}
          className="border-line bg-raised h-10 min-w-0 flex-1 rounded-full border px-4 text-sm"
        />
        <button type="submit" disabled={!custom.trim()} className={smallButton}>
          {t('common.save')}
        </button>
      </form>
    </div>
  );
}

export function CatalogTab({
  entry,
  media,
  onPick,
  onDetach,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onPick: (m: Parameters<Parameters<typeof CatalogPicker>[0]['onPick']>[0]) => void;
  onDetach: () => void;
}) {
  const { t } = useI18n();
  const off = entry.identity === 'off-catalog';
  return (
    <div className="flex flex-col gap-4">
      <Current
        cover={off ? null : (media.coverUrl ?? entry.coverUrl)}
        title={off ? undefined : media.title}
        detail={[
          media.providers
            .filter((p) => p !== 'local' && p !== 'kavita')
            .map((p) => t(`provider.${p}`))
            .join(', '),
          media.year,
        ]
          .filter(Boolean)
          .join(' · ')}
        empty={t('match.offCatalogShort')}
      />
      <Hint>{off ? t('match.catalogOff') : t('match.catalogWrongHint')}</Hint>
      {!off && (
        <button type="button" onClick={onDetach} className={cx(smallButton, 'self-start')}>
          {t('match.detach')}
        </button>
      )}
      <span className="text-muted mt-2 text-xs tracking-[0.14em] uppercase">
        {off ? t('match.attachCatalog') : t('match.changeWork')}
      </span>
      <CatalogPicker initial={entry.title} onPick={onPick} />
    </div>
  );
}

export function KavitaTab({
  entry,
  media,
  onPick,
  onCoverSync,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onPick: (id: number | null) => void;
  onCoverSync: (on: boolean) => void;
}) {
  const { t, n } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <Current
        cover={media.kavita ? `/api/kavita/image?seriesId=${media.kavita.seriesId}` : null}
        title={media.kavita ? entry.title : undefined}
        detail={
          media.kavita
            ? `${media.kavita.libraryName} · ${entry.ownedAsVolumes ? t('unit.volume') : t('kavita.chapterCount', { n: n(media.kavita.chapters) })}`
            : undefined
        }
        empty={t('match.kavitaNone')}
      />
      <Hint>{t('match.kavitaHint')}</Hint>
      {media.kavita && (
        <label className="flex items-center justify-between gap-4 rounded-2xl bg-white/[0.04] p-3 text-sm">
          <span className="flex flex-col gap-0.5">
            <span>{t('match.kavitaCoverSync')}</span>
            <span className="text-muted text-xs">{t('match.kavitaCoverSyncHint')}</span>
          </span>
          <input
            type="checkbox"
            checked={entry.kavitaCoverSync ?? true}
            onChange={(e) => onCoverSync(e.target.checked)}
            className="accent-fg size-[18px] shrink-0"
          />
        </label>
      )}
      <KavitaPicker initial={entry.title} onPick={onPick} onNone={() => onPick(null)} />
    </div>
  );
}

function ScanProgress({ lanes, onScan }: { lanes: Lane[] | null; onScan: () => void }) {
  const { t, n } = useI18n();
  const total = lanes?.length ?? 0;
  const done = (lanes ?? []).filter((l) => l.state !== 'loading').length;
  const failed = (lanes ?? []).filter((l) => l.state === 'error').length;
  const running = lanes === null || done < total;
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3 text-sm">
      <div className="flex items-center gap-2">
        {running ? <Spinner /> : <span className="text-ok">✓</span>}
        <span className="flex-1">
          {running
            ? total
              ? t('match.scanProgress', { done: n(done), total: n(total) })
              : t('match.scanStarting')
            : t('match.scanDone', { total: n(total) })}
          {failed > 0 && (
            <span className="text-warn"> · {t('match.scanFailed', { count: failed })}</span>
          )}
        </span>
        {!running && (
          <button type="button" onClick={onScan} className="text-mid text-xs hover:text-white">
            {t('match.rescan')}
          </button>
        )}
      </div>
      {running && total > 0 && (
        <span className="h-1 overflow-hidden rounded-full bg-white/10">
          <span
            className="bg-fg block h-full rounded-full transition-[width] duration-500"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </span>
      )}
    </div>
  );
}

export function SourcesTab({
  entry,
  sources,
  lanes,
  onScan,
  onSources,
}: {
  entry: TrackedMedia | undefined;
  sources: ChapterSelection[];
  lanes: Lane[] | null;
  onScan: (q?: string) => void;
  onSources: (next: ChapterSelection[]) => void;
}) {
  const [query, setQuery] = useState(entry?.title ?? '');
  const scanning = lanes === null || lanes.some((l) => l.state === 'loading');
  const { t, n, language } = useI18n();
  const relative = useRelativeTime();
  const linked = new Set(sources.map((s) => `${s.sourceId}:${s.suwayomiMangaId}`));
  const status = (s: ChapterSelection) =>
    entry?.sourceStatus?.find(
      (x) => x.suwayomiMangaId === s.suwayomiMangaId && x.sourceId === s.sourceId,
    );
  const best = Math.max(0, ...(entry?.sourceStatus ?? []).map((x) => x.latestChapter ?? 0));
  const candidates = (lanes ?? [])
    .flatMap((l) =>
      l.candidates
        .filter((c) => !linked.has(`${c.sourceId}:${c.suwayomiMangaId}`))
        .map((c) => ({ ...c, sourceName: l.source.name })),
    )
    .sort((a, b) => rankSourceCandidates(a, b, language));
  const move = (i: number, d: -1 | 1) => {
    const next = [...sources];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onSources(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('match.sourcesHint')}</Hint>
      <div className="flex flex-col items-start gap-2 rounded-2xl bg-white/[0.04] p-3">
        <button
          type="button"
          disabled={scanning}
          onClick={() => onScan()}
          className={cx(primaryButton, 'h-10 gap-2 px-4 text-sm')}
        >
          {scanning && <Spinner className="size-3.5" />}
          {scanning ? t('match.autoSearching') : t('match.autoSearch')}
        </button>
        <span className="text-muted text-xs leading-relaxed">
          {t(sources.length ? 'match.autoSearchHintLinked' : 'match.autoSearchHint')}
        </span>
      </div>
      {sources.length === 0 && (
        <Current empty={searching(entry) ? t('match.searchingBackground') : t('match.noSource')} />
      )}
      <ol className="flex flex-col gap-2">
        {sources.map((s, i) => {
          const st = status(s);
          const behind = st?.latestChapter != null && best > 0 && st.latestChapter < best;
          return (
            <li
              key={`${s.sourceId}:${s.suwayomiMangaId}`}
              className="flex items-center gap-3 rounded-2xl bg-white/[0.05] p-2.5 text-sm"
            >
              <Cover src={st?.thumbnailUrl} className="w-10 shrink-0 shadow-none" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  {n(i + 1)}. {s.sourceName}
                  {st?.auto && (
                    <span className="text-muted ml-2 text-xs font-normal">{t('match.auto')}</span>
                  )}
                </span>
                <span className="text-muted truncate text-xs">{st?.title ?? '—'}</span>
                <span
                  className={cx(
                    'text-xs',
                    st?.error ? 'text-bad' : behind ? 'text-warn' : 'text-mid',
                  )}
                >
                  {st?.error
                    ? t('search.laneError')
                    : st?.latestChapter != null
                      ? t('match.latest', { n: n(st.latestChapter), when: relative(st.checkedAt) })
                      : t('match.notChecked')}
                </span>
              </span>
              <span className="flex shrink-0 gap-0.5">
                <Small label={t('sources.up')} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </Small>
                <Small
                  label={t('sources.down')}
                  disabled={i === sources.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Small>
                <Small
                  label={t('sources.remove')}
                  onClick={() => onSources(sources.filter((_, j) => j !== i))}
                >
                  ✕
                </Small>
              </span>
            </li>
          );
        })}
      </ol>
      <span className="text-muted mt-2 text-xs tracking-[0.14em] uppercase">
        {t('match.addSource')}
      </span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onScan(query);
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('match.sourcesSearch')}
          aria-label={t('match.sourcesSearch')}
          maxLength={200}
          className="border-line bg-raised h-10 min-w-0 flex-1 rounded-full border px-4 text-sm"
        />
        <button type="submit" disabled={!query.trim()} className={smallButton}>
          {t('extsearch.run')}
        </button>
      </form>
      <ScanProgress lanes={lanes} onScan={() => onScan(query)} />
      <div className="flex flex-col gap-1">
        {candidates.slice(0, 20).map((c) => (
          <button
            key={`${c.sourceId}:${c.suwayomiMangaId}`}
            type="button"
            onClick={() =>
              onSources([
                ...sources,
                {
                  suwayomiMangaId: c.suwayomiMangaId,
                  sourceId: c.sourceId,
                  sourceName: c.sourceName,
                },
              ])
            }
            className="flex items-center gap-3 rounded-xl p-2 text-left text-sm hover:bg-white/[0.05]"
          >
            <Cover src={c.thumbnailUrl} className="w-9 shrink-0 shadow-none" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{c.title}</span>
              <span className="text-muted flex items-center gap-1.5 truncate text-xs">
                <Dot tone={c.score >= 0.9 ? 'ok' : 'warn'} />
                {c.sourceName}
                {c.lang && c.lang !== 'all' ? ` (${c.lang.toUpperCase()})` : ''} ·{' '}
                {c.score >= 0.9 ? t('sources.exact') : t('sources.doubtful')}
              </span>
            </span>
            <span className={smallButton}>{t('match.add')}</span>
          </button>
        ))}
        {lanes && !lanes.some((l) => l.state === 'loading') && candidates.length === 0 && (
          <p className="text-muted text-sm">{t('match.noCandidate')}</p>
        )}
      </div>
    </div>
  );
}

export function CoverTab({
  entry,
  media,
  onBackdrop,
  lanes,
  sources,
  onPick,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onBackdrop: (b: 'auto' | 'hidden') => Promise<void>;
  lanes: Lane[] | null;
  sources: ChapterSelection[];
  onPick: (c: CoverChoice) => Promise<void>;
}) {
  const { t } = useI18n();
  const options = useApi<CoverOption[]>(`/api/tracked/covers?id=${entry.id}`);
  const [pending, setPending] = useState<string | null>(null);
  const [dead, setDead] = useState<Set<string>>(new Set());
  const current = entry.coverChoice;
  const keyOf = (o: Pick<CoverOption, 'origin' | 'id'>) => `${o.origin}:${o.id}`;
  // Every source result of the live scan is a candidate too, linked or not.
  const known = new Set((options.data ?? []).map(keyOf));
  const scanned: CoverOption[] = (lanes ?? []).flatMap((l) =>
    l.candidates.flatMap((c) => {
      const o = {
        origin: 'source' as const,
        id: `${c.sourceId}:${c.suwayomiMangaId}`,
        label: l.source.name,
        url: c.thumbnailUrl ?? '',
      };
      return c.thumbnailUrl && !known.has(keyOf(o)) ? [o] : [];
    }),
  );
  const all = [...(options.data ?? []), ...scanned].filter((o) => !dead.has(keyOf(o)));
  const linked = new Set(sources.map((s) => `${s.sourceId}:${s.suwayomiMangaId}`));
  const pick = async (choice: CoverChoice, key: string) => {
    setPending(key);
    await onPick(choice);
    setPending(null);
  };
  const isCurrent = (o: CoverOption) =>
    current !== 'auto' && current.origin === o.origin && current.id === o.id;
  const scanning = lanes === null || lanes.some((l) => l.state === 'loading');
  const groups = [
    { origin: 'catalog' as const, title: t('match.origin.catalog') },
    { origin: 'kavita' as const, title: t('match.origin.kavita') },
    { origin: 'source' as const, title: t('match.origin.sources') },
  ];
  return (
    <div className="flex flex-col gap-5">
      <Hint>{t('match.coverHint')}</Hint>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        <Tile
          selected={current === 'auto'}
          pending={pending === 'auto'}
          onClick={() => pick('auto', 'auto')}
          label={t('match.coverAuto')}
        >
          <Cover
            src={current === 'auto' ? entry.coverUrl : (all[0]?.url ?? null)}
            fallbacks={current === 'auto' ? entry.coverFallbacks : undefined}
            className="shadow-none"
          />
        </Tile>
      </div>
      {groups.map((g) => {
        const list = all.filter((o) => o.origin === g.origin);
        const loading = g.origin === 'source' ? scanning : !options.data;
        if (!list.length && !loading) return null;
        return (
          <div key={g.origin} className="flex flex-col gap-2">
            <span className="text-muted flex items-center gap-2 text-xs tracking-[0.14em] uppercase">
              {g.title}
              {loading && <Spinner className="size-3" />}
            </span>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {list.map((o) => (
                <Tile
                  key={keyOf(o)}
                  selected={isCurrent(o)}
                  pending={pending === keyOf(o)}
                  onClick={() => pick({ origin: o.origin, id: o.id }, keyOf(o))}
                  label={o.label}
                  note={
                    o.origin === 'source' && !linked.has(o.id) ? t('match.notLinked') : undefined
                  }
                >
                  <Cover
                    src={o.url}
                    className="shadow-none"
                    onUnavailable={() => setDead((d) => new Set(d).add(keyOf(o)))}
                  />
                </Tile>
              ))}
              {loading &&
                Array.from({ length: list.length ? 1 : 3 }, (_, i) => (
                  <Skeleton key={i} className="aspect-[2/3] rounded-lg" />
                ))}
            </div>
          </div>
        );
      })}
      {!scanning && options.data && all.length === 0 && (
        <p className="text-muted text-sm">{t('match.noCover')}</p>
      )}
      <KavitaCoverState entry={entry} />
      <BackdropSection entry={entry} media={media} onChange={onBackdrop} />
    </div>
  );
}

function Tile({
  selected,
  pending,
  onClick,
  label,
  note,
  children,
}: {
  selected: boolean;
  pending: boolean;
  onClick: () => void;
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'relative flex flex-col gap-1.5 rounded-xl p-1.5 text-left transition-colors',
        selected ? 'ring-fg bg-white/[0.06] ring-2' : 'hover:bg-white/[0.06]',
      )}
    >
      {children}
      {(pending || selected) && (
        <span className="bg-fg text-bg absolute top-3 right-3 flex size-6 items-center justify-center rounded-full text-xs font-bold">
          {pending ? <Spinner className="size-3" /> : '✓'}
        </span>
      )}
      <span className="flex flex-col px-0.5">
        <span className="truncate text-xs">{label}</span>
        {note && <span className="text-muted truncate text-[11px]">{note}</span>}
      </span>
    </button>
  );
}

function Small({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-mid flex size-9 items-center justify-center rounded-full hover:bg-white/[0.08] disabled:opacity-25"
    >
      {children}
    </button>
  );
}

function BackdropSection({
  entry,
  media,
  onChange,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onChange: (b: 'auto' | 'hidden') => Promise<void>;
}) {
  const { t } = useI18n();
  const banner = entry.identity === 'catalog' ? media.bannerUrl : null;
  const shown = Boolean(banner) && entry.backdrop !== 'hidden';
  return (
    <div className="border-line mt-2 flex flex-col gap-3 border-t pt-5">
      <span className="text-muted text-xs tracking-[0.14em] uppercase">{t('match.backdrop')}</span>
      {banner ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- remote catalog banner */}
          <img
            src={banner}
            alt=""
            referrerPolicy="no-referrer"
            className={cx(
              'aspect-[3/1] w-full rounded-xl object-cover transition-opacity',
              !shown && 'opacity-30 grayscale',
            )}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-mid text-sm">
              {shown ? t('match.backdropShown') : t('match.backdropHidden')}
            </span>
            <button
              type="button"
              onClick={() => onChange(shown ? 'hidden' : 'auto')}
              className={smallButton}
            >
              {shown ? t('match.backdropHide') : t('match.backdropShow')}
            </button>
          </div>
        </>
      ) : (
        <p className="text-muted text-sm">{t('match.backdropNone')}</p>
      )}
    </div>
  );
}

function KavitaCoverState({ entry }: { entry: TrackedMedia }) {
  const { t } = useI18n();
  const state = entry.kavitaCover?.state ?? 'none';
  if (state === 'none') return null;
  return (
    <p
      className={cx(
        'flex items-center gap-2 text-sm',
        state === 'failed' ? 'text-warn' : 'text-mid',
      )}
    >
      {state === 'pending' ? (
        <Spinner className="size-3" />
      ) : (
        <Dot tone={state === 'synced' ? 'ok' : 'warn'} />
      )}
      {state === 'failed'
        ? t('match.kavitaCoverFailed', {
            reason:
              t(`error.${entry.kavitaCover.error}`) === `error.${entry.kavitaCover.error}`
                ? t('error.KAVITA_SCAN_ERROR')
                : t(`error.${entry.kavitaCover.error}`),
          })
        : t(`match.kavitaCover.${state}`)}
    </p>
  );
}
