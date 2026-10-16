'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type {
  ChapterSelection,
  CoverChoice,
  CoverOption,
  MediaDetail,
  Source,
  SourceCandidate,
  TrackedMedia,
} from '@/types/shared';
import { libraryKeys, mediaHref, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { CatalogPicker, KavitaPicker } from './relink';
import { Cover, Dot, Segmented, Skeleton, Spinner, cx, errorText, smallButton } from './ui';

export type Lane = {
  source: Source;
  state: 'loading' | 'done' | 'error';
  candidates: SourceCandidate[];
};
export type Section = 'catalog' | 'sources' | 'kavita' | 'cover';
type Save = { state: 'saving' } | { state: 'saved' } | { state: 'error'; text: string } | null;

const searching = (e: TrackedMedia | undefined) =>
  e?.sourceMatch === 'queued' || e?.sourceMatch === 'searching';

/** Three independent links (catalog, sources, Kavita), each with its state; rows open the manager. */
export function MatchesSummary({
  entry,
  media,
  sources,
  onOpen,
}: {
  entry: TrackedMedia | undefined;
  media: MediaDetail;
  sources: ChapterSelection[];
  onOpen: (section: Section) => void;
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
        ? t('match.kavitaShort', { library: media.kavita.libraryName, n: n(media.kavita.chapters) })
        : t('match.kavitaNone'),
      tone: media.kavita ? (entry?.kavitaCover?.state === 'failed' ? 'warn' : 'ok') : 'idle',
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted text-xs tracking-[0.16em] uppercase">{t('match.title')}</span>
      <div className="flex flex-col text-sm">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onOpen(r.key)}
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
          </button>
        ))}
      </div>
    </div>
  );
}

/** The single place to fix a title's catalog work, sources, Kavita series and cover. */
export function MatchesDrawer({
  open,
  section,
  onSection,
  onClose,
  entry,
  media,
  sources,
  lanes,
  scanStarted,
  onScan,
  onSources,
  onTrack,
}: {
  open: boolean;
  /** Adds the title to the library, which makes catalog/Kavita/cover settings available. */
  onTrack?: () => Promise<void>;
  /** A scan already ran or is running for this title (the drawer then never starts another). */
  scanStarted: boolean;
  section: Section;
  onSection: (s: Section) => void;
  onClose: () => void;
  entry: TrackedMedia | undefined;
  media: MediaDetail;
  sources: ChapterSelection[];
  lanes: Lane[] | null;
  onScan: () => void;
  onSources: (next: ChapterSelection[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const [save, setSave] = useState<Save>(null);

  // Sources and covers need the live scan: start it as soon as one of those tabs is shown.
  const wantsScan = open && (section === 'sources' || section === 'cover');
  useEffect(() => {
    if (wantsScan && !scanStarted) onScan();
  }, [wantsScan, scanStarted, onScan]);

  async function run(action: () => Promise<unknown>) {
    setSave({ state: 'saving' });
    try {
      await action();
      await mutate(libraryKeys);
      setSave({ state: 'saved' });
    } catch (e) {
      setSave({ state: 'error', text: errorText(t, e) });
    }
  }
  const patch = (body: object) =>
    send<TrackedMedia>('/api/tracked', 'PATCH', { id: entry!.id, ...body });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setSave(null);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-y-0 right-0 z-50 flex w-full max-w-[580px] flex-col border-l outline-none">
          <div className="flex flex-col gap-5 p-5 pb-4 md:p-8 md:pb-5">
            <div className="flex items-start gap-4">
              <Cover
                src={entry?.coverUrl ?? media.coverUrl}
                fallbacks={entry?.coverFallbacks}
                className="w-14 shrink-0 shadow-none"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Dialog.Title className="font-display truncate text-[22px] leading-none font-extrabold tracking-[-0.03em] md:text-[28px]">
                  {t('match.title')}
                </Dialog.Title>
                <Dialog.Description className="text-muted truncate font-serif text-lg italic">
                  {media.title}
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="text-mid -mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08]"
                aria-label={t('common.close')}
              >
                ✕
              </Dialog.Close>
            </div>
            <Segmented
              value={section}
              onChange={onSection}
              label={t('match.title')}
              items={[
                { id: 'catalog', label: t('match.catalog') },
                { id: 'sources', label: t('match.sources') },
                { id: 'kavita', label: 'Kavita' },
                { id: 'cover', label: t('match.tab.images') },
              ]}
            />
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-8 md:px-8">
            {!entry && section !== 'sources' ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-mid">{t('match.trackFirst')}</p>
                {onTrack && (
                  <button type="button" onClick={() => run(onTrack)} className={smallButton}>
                    {t('match.addToLibrary')}
                  </button>
                )}
              </div>
            ) : section === 'catalog' ? (
              <CatalogTab
                entry={entry!}
                media={media}
                onPick={(m) =>
                  run(async () => {
                    const u = await patch({ media: m });
                    window.location.assign(mediaHref(u.media.id));
                  })
                }
                onDetach={() =>
                  run(async () => {
                    const u = await patch({ offCatalog: true });
                    window.location.assign(mediaHref(u.media.id));
                  })
                }
              />
            ) : section === 'sources' ? (
              <SourcesTab
                entry={entry}
                sources={sources}
                lanes={lanes}
                onScan={onScan}
                onSources={(next) => run(() => onSources(next))}
              />
            ) : section === 'kavita' ? (
              <KavitaTab
                entry={entry!}
                media={media}
                onPick={(id) => run(() => patch({ kavitaSeriesId: id }))}
              />
            ) : (
              <CoverTab
                entry={entry!}
                media={media}
                onBackdrop={(backdrop) => run(() => patch({ backdrop }))}
                lanes={lanes}
                sources={sources}
                onPick={(cover) => run(() => patch({ cover }))}
              />
            )}
          </div>
          <SaveBar save={save} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SaveBar({ save }: { save: Save }) {
  const { t } = useI18n();
  return (
    <div
      aria-live="polite"
      className={cx(
        'border-line flex min-h-12 items-center gap-2 border-t px-5 text-sm md:px-8',
        !save && 'text-muted',
      )}
    >
      {save?.state === 'saving' && (
        <>
          <Spinner />
          {t('match.saving')}
        </>
      )}
      {save?.state === 'saved' && (
        <span className="text-ok flex items-center gap-2">✓ {t('match.saved')}</span>
      )}
      {save?.state === 'error' && <span className="text-bad">{save.text}</span>}
      {!save && t('match.saveHint')}
    </div>
  );
}

/** One linked thing, shown the same way in every tab. */
function Current({
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

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-mid text-sm leading-relaxed">{children}</p>;
}

function CatalogTab({
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

function KavitaTab({
  entry,
  media,
  onPick,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onPick: (id: number | null) => void;
}) {
  const { t, n } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <Current
        cover={media.kavita ? `/api/kavita/image?seriesId=${media.kavita.seriesId}` : null}
        title={media.kavita ? entry.title : undefined}
        detail={
          media.kavita
            ? `${media.kavita.libraryName} · ${t('kavita.chapterCount', { n: n(media.kavita.chapters) })}`
            : undefined
        }
        empty={t('match.kavitaNone')}
      />
      <Hint>{t('match.kavitaHint')}</Hint>
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

function SourcesTab({
  entry,
  sources,
  lanes,
  onScan,
  onSources,
}: {
  entry: TrackedMedia | undefined;
  sources: ChapterSelection[];
  lanes: Lane[] | null;
  onScan: () => void;
  onSources: (next: ChapterSelection[]) => void;
}) {
  const { t, n } = useI18n();
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
    .sort((a, b) => b.score - a.score || (b.chapterCount ?? 0) - (a.chapterCount ?? 0));
  const move = (i: number, d: -1 | 1) => {
    const next = [...sources];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onSources(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('match.sourcesHint')}</Hint>
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
      <ScanProgress lanes={lanes} onScan={onScan} />
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
                {c.sourceName} · {c.score >= 0.9 ? t('sources.exact') : t('sources.doubtful')}
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

function CoverTab({
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
