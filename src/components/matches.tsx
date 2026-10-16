'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import type {
  ChapterSelection,
  CoverChoice,
  CoverOption,
  MediaDetail,
  Source,
  SourceCandidate,
  TrackedMedia,
} from '@/types/shared';
import { mediaHref, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { CatalogPicker, KavitaPicker } from './relink';
import { Cover, Dot, Skeleton, cx, errorText, roman, smallButton } from './ui';

export type Lane = {
  source: Source;
  state: 'loading' | 'done' | 'error';
  candidates: SourceCandidate[];
};
type Section = 'catalog' | 'sources' | 'kavita' | 'cover';

/** Compact "what is this title linked to" block on the title sheet; opens the full manager. */
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
  const rows: { key: Section; label: string; value: string; tone?: 'warn' }[] = [
    {
      key: 'catalog',
      label: t('match.catalog'),
      value:
        entry?.identity === 'off-catalog' ||
        (media.providers.length === 1 && media.providers[0] === 'kavita')
          ? t('match.offCatalogShort')
          : media.providers
              .filter((p) => p !== 'local')
              .map((p) => t(`provider.${p}`))
              .join(', ') || '—',
    },
    {
      key: 'sources',
      label: t('match.sources'),
      value: sources.length
        ? latest
          ? t('match.sourcesValue', { count: sources.length, n: n(latest) })
          : t('match.sourcesCount', { count: sources.length })
        : t('match.noSource'),
      tone: sources.length ? undefined : 'warn',
    },
    {
      key: 'kavita',
      label: 'Kavita',
      value: media.kavita
        ? t('match.kavitaShort', { library: media.kavita.libraryName, n: n(media.kavita.chapters) })
        : t('match.kavitaNone'),
    },
    {
      key: 'cover',
      label: t('match.cover'),
      value:
        !entry || entry.coverChoice === 'auto'
          ? t('match.coverAuto')
          : t(`match.origin.${entry.coverChoice.origin}`),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <span className="text-muted text-xs tracking-[0.16em] uppercase">{t('match.title')}</span>
      <dl className="flex flex-col text-sm">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onOpen(r.key)}
            className="border-line group flex items-center justify-between gap-4 border-b py-2.5 text-left"
          >
            <dt className="text-muted shrink-0">{r.label}</dt>
            <dd
              className={cx(
                'flex min-w-0 items-center gap-2 text-right',
                r.tone === 'warn' && 'text-warn',
              )}
            >
              <span className="truncate">{r.value}</span>
              <span aria-hidden className="text-faint group-hover:text-fg">
                ›
              </span>
            </dd>
          </button>
        ))}
      </dl>
      <button
        type="button"
        onClick={() => onOpen('catalog')}
        className={cx(smallButton, 'self-start')}
      >
        {t('match.manage')}
      </button>
    </div>
  );
}

/** The single place to fix a title's catalog work, sources, Kavita series and cover. */
export function MatchesDrawer({
  open,
  section,
  onClose,
  entry,
  media,
  sources,
  lanes,
  onScan,
  onSources,
  onChanged,
}: {
  open: boolean;
  section: Section;
  onClose: () => void;
  entry: TrackedMedia | undefined;
  media: MediaDetail;
  sources: ChapterSelection[];
  lanes: Lane[] | null;
  onScan: () => void;
  onSources: (next: ChapterSelection[]) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<'catalog' | 'kavita' | null>(null);
  async function patch(body: object, after?: (updated: TrackedMedia) => void) {
    if (!entry) return;
    setError(null);
    try {
      const updated = await send<TrackedMedia>('/api/tracked', 'PATCH', { id: entry.id, ...body });
      await onChanged();
      setPicking(null);
      after?.(updated);
    } catch (e) {
      setError(errorText(t, e));
    }
  }
  const sections: { key: Section; title: string; body: ReactNode }[] = [
    {
      key: 'catalog',
      title: t('match.catalog'),
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-mid text-sm">
            {entry?.identity === 'off-catalog'
              ? t('match.catalogOff')
              : t('match.catalogOn', { title: media.title })}
          </p>
          {entry ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={smallButton}
                onClick={() => setPicking(picking === 'catalog' ? null : 'catalog')}
              >
                {entry.identity === 'off-catalog'
                  ? t('match.attachCatalog')
                  : t('match.changeWork')}
              </button>
              {entry.identity !== 'off-catalog' && (
                <button
                  type="button"
                  className={smallButton}
                  onClick={() =>
                    patch({ offCatalog: true }, (u) =>
                      window.location.assign(mediaHref(u.media.id)),
                    )
                  }
                >
                  {t('match.detach')}
                </button>
              )}
            </div>
          ) : (
            <p className="text-muted text-xs">{t('match.trackFirst')}</p>
          )}
          {picking === 'catalog' && (
            <CatalogPicker
              initial={entry?.title ?? media.title}
              onPick={(m) => patch({ media: m }, () => window.location.assign(mediaHref(m.id)))}
            />
          )}
        </div>
      ),
    },
    {
      key: 'sources',
      title: t('match.sources'),
      body: (
        <SourcesManager
          entry={entry}
          sources={sources}
          lanes={lanes}
          onScan={onScan}
          onSources={onSources}
        />
      ),
    },
    {
      key: 'kavita',
      title: 'Kavita',
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-mid text-sm">
            {media.kavita
              ? t('match.kavitaLinked', {
                  library: media.kavita.libraryName,
                  n: media.kavita.chapters,
                })
              : t('match.kavitaNone')}
          </p>
          {entry ? (
            <>
              <button
                type="button"
                className={cx(smallButton, 'self-start')}
                onClick={() => setPicking(picking === 'kavita' ? null : 'kavita')}
              >
                {t('match.change')}
              </button>
              {picking === 'kavita' && (
                <KavitaPicker
                  initial={entry.title}
                  onPick={(id) => patch({ kavitaSeriesId: id })}
                  onNone={() => patch({ kavitaSeriesId: null })}
                />
              )}
            </>
          ) : (
            <p className="text-muted text-xs">{t('match.trackFirst')}</p>
          )}
        </div>
      ),
    },
    {
      key: 'cover',
      title: t('match.cover'),
      body: entry ? (
        <CoverPicker entry={entry} onPick={(cover) => patch({ cover })} />
      ) : (
        <p className="text-muted text-xs">{t('match.trackFirst')}</p>
      ),
    },
  ];
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="bg-bg border-line fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col overflow-y-auto border-l p-5 outline-none md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="font-display text-[30px] leading-none font-extrabold tracking-[-0.03em]">
                {t('match.title')}
              </Dialog.Title>
              <Dialog.Description className="text-muted font-serif text-lg italic">
                {media.title}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="text-mid flex size-11 items-center justify-center rounded-full hover:bg-white/[0.08]"
              aria-label={t('common.close')}
            >
              ✕
            </Dialog.Close>
          </div>
          {error && <p className="text-bad mt-4 text-sm">{error}</p>}
          <div className="mt-6 flex flex-col gap-8">
            {sections.map((s, i) => (
              <section
                key={s.key}
                id={`match-${s.key}`}
                className={cx(
                  'flex flex-col gap-3 rounded-2xl p-4',
                  section === s.key ? 'bg-white/[0.05]' : '',
                )}
              >
                <h3 className="flex items-baseline gap-3">
                  <span className="text-muted font-serif text-lg">{roman(i + 1)}</span>
                  <span className="font-display text-xl font-bold">{s.title}</span>
                </h3>
                {s.body}
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SourcesManager({
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
  const linked = new Set(sources.map((s) => s.suwayomiMangaId));
  const status = (s: ChapterSelection) =>
    entry?.sourceStatus?.find((x) => x.suwayomiMangaId === s.suwayomiMangaId);
  const best = Math.max(0, ...(entry?.sourceStatus ?? []).map((x) => x.latestChapter ?? 0));
  const scanning = (lanes ?? []).some((l) => l.state === 'loading');
  const candidates = (lanes ?? []).flatMap((l) =>
    l.candidates
      .filter((c) => !linked.has(c.suwayomiMangaId))
      .map((c) => ({ ...c, sourceName: l.source.name })),
  );
  const move = (i: number, d: -1 | 1) => {
    const next = [...sources];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onSources(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-mid text-sm">{t('match.sourcesHint')}</p>
      {sources.length === 0 && <p className="text-warn text-sm">{t('match.noSource')}</p>}
      <ol className="flex flex-col gap-2">
        {sources.map((s, i) => {
          const st = status(s);
          const behind = st?.latestChapter != null && best > 0 && st.latestChapter < best;
          return (
            <li
              key={`${s.sourceId}:${s.suwayomiMangaId}`}
              className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2.5 text-sm"
            >
              <Cover src={st?.thumbnailUrl} className="w-9 shrink-0 shadow-none" />
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
                    ? t(`error.${st.error}`) === `error.${st.error}`
                      ? t('search.laneError')
                      : t(`error.${st.error}`)
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
      <button
        type="button"
        onClick={onScan}
        disabled={scanning}
        className={cx(smallButton, 'self-start')}
      >
        {scanning
          ? t('sources.matching', {
              count: (lanes ?? []).filter((l) => l.state === 'loading').length,
            })
          : t('match.scanAll')}
      </button>
      {candidates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted text-xs">{t('sources.otherMatches')}</span>
          {candidates.slice(0, 12).map((c) => (
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
              <Cover src={c.thumbnailUrl} className="w-8 shrink-0 shadow-none" />
              <Dot tone={c.score >= 0.9 ? 'ok' : 'warn'} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{c.sourceName}</span>
                <span className="text-muted truncate text-xs">{c.title}</span>
              </span>
              <span className="text-muted font-serif italic">
                {c.score >= 0.9 ? t('sources.exact') : t('sources.doubtful')}
              </span>
              <span aria-hidden>+</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CoverPicker({ entry, onPick }: { entry: TrackedMedia; onPick: (c: CoverChoice) => void }) {
  const { t } = useI18n();
  const options = useApi<CoverOption[]>(`/api/tracked/covers?id=${entry.id}`);
  const current = entry.coverChoice;
  const isCurrent = (o: CoverOption) =>
    current !== 'auto' && current.origin === o.origin && current.id === o.id;
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-pressed={current === 'auto'}
        onClick={() => onPick('auto')}
        className={cx(
          'self-start rounded-full px-4 py-2 text-sm',
          current === 'auto' ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.08]',
        )}
      >
        {t('match.coverAuto')}
      </button>
      {!options.data && <Skeleton className="h-40 rounded-xl" />}
      {(['catalog', 'source', 'kavita'] as const).map((origin) => {
        const list = (options.data ?? []).filter((o) => o.origin === origin);
        if (!list.length) return null;
        return (
          <div key={origin} className="flex flex-col gap-2">
            <span className="text-muted text-xs tracking-[0.14em] uppercase">
              {t(`match.origin.${origin}`)}
            </span>
            <div className="grid grid-cols-4 gap-2.5">
              {list.map((o) => (
                <button
                  key={`${o.origin}:${o.id}`}
                  type="button"
                  aria-pressed={isCurrent(o)}
                  title={o.label}
                  onClick={() => onPick({ origin: o.origin, id: o.id })}
                  className={cx(
                    'flex flex-col gap-1 rounded-lg p-1 text-left',
                    isCurrent(o) ? 'ring-fg ring-2' : 'hover:bg-white/[0.06]',
                  )}
                >
                  <Cover src={o.url} className="shadow-none" />
                  <span className="text-muted truncate text-[11px]">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {options.data?.length === 0 && <p className="text-muted text-sm">{t('match.noCover')}</p>}
    </div>
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
      className="text-mid flex size-8 items-center justify-center rounded-full hover:bg-white/[0.08] disabled:opacity-25"
    >
      {children}
    </button>
  );
}
