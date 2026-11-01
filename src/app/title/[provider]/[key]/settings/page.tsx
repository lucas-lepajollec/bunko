'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import type { ChapterSelection, MediaDetail, TrackedMedia } from '@/types/shared';
import { libraryKeys, mediaHref, send, useApi } from '@/lib/client/api';
import { useSourceScan } from '@/lib/client/use-source-scan';
import { useI18n } from '@/i18n/I18nProvider';
import {
  CatalogTab,
  CoverTab,
  KavitaTab,
  SourcesTab,
  type Save,
  type Section,
} from '@/components/matches';
import { GeneralTab } from '@/components/work-settings';
import { trackedFor } from '@/lib/client/tracked-entry';
import {
  Cover,
  Empty,
  ErrorNote,
  Skeleton,
  Spinner,
  cx,
  errorText,
  smallButton,
} from '@/components/ui';

const SECTIONS: Section[] = ['general', 'catalog', 'sources', 'kavita', 'cover'];

export default function WorkSettingsPage() {
  return (
    <Suspense>
      <WorkSettingsRoute />
    </Suspense>
  );
}

function WorkSettingsRoute() {
  const { provider, key } = useParams<{ provider: string; key: string }>();
  const id = `${provider}:${decodeURIComponent(key)}`;
  const { t } = useI18n();
  const detail = useApi<MediaDetail>(`/api/media?id=${encodeURIComponent(id)}`, {
    dedupingInterval: 1000,
  });
  if (detail.error && !detail.data)
    return (
      <main className="mx-auto max-w-[760px] px-4 pt-24 md:pt-32">
        <Empty title={t('title.unavailable')}>
          <ErrorNote error={detail.error} />
        </Empty>
      </main>
    );
  if (!detail.data)
    return (
      <main className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-24 md:pt-32">
        <Skeleton className="h-14 w-2/3" />
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </main>
    );
  return <WorkSettings key={id} media={detail.data} />;
}

function WorkSettings({ media }: { media: MediaDetail }) {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { mutate } = useSWRConfig();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const entry = trackedFor(library.data, media);
  const isComic = media.type === 'MANGA';
  const sections = SECTIONS.filter((s) => isComic || (s !== 'sources' && s !== 'kavita'));
  const requested = params.get('s') as Section | null;
  const section: Section = requested && sections.includes(requested) ? requested : 'general';
  const [save, setSave] = useState<Save>(null);

  const stored = entry?.sources.length ? entry.sources : null;
  const fromDetail: ChapterSelection[] = media.sources.map((s) => ({
    suwayomiMangaId: s.suwayomiMangaId,
    sourceId: s.sourceId,
    sourceName: s.sourceName,
  }));
  const sources = stored ?? fromDetail;
  const scan = useSourceScan(media.id, { ready: library.data !== undefined, auto: false });
  // Sources and covers need the live scan: start it as soon as one of those sections is shown.
  const wantsScan = isComic && (section === 'sources' || section === 'cover');
  const { started, rescan } = scan;
  useEffect(() => {
    if (wantsScan && !started) rescan();
  }, [wantsScan, started, rescan]);

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
  const label = (s: Section) =>
    s === 'general'
      ? t('settings.work.general')
      : s === 'kavita'
        ? 'Kavita'
        : s === 'cover'
          ? t('match.tab.images')
          : t(`match.${s}`);
  const go = (s: Section) => {
    setSave(null);
    router.replace(`${mediaHref(media.id)}/settings${s === 'general' ? '' : `?s=${s}`}`, {
      scroll: false,
    });
  };

  return (
    <main
      className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 pt-20 pb-28 md:px-8 md:pt-28"
      style={{ ['--accent' as string]: media.color ?? '#9fb6ff' }}
    >
      <Link href={mediaHref(media.id)} className="text-mid self-start text-sm hover:text-white">
        ← {entry?.title ?? media.title}
      </Link>
      <header className="flex items-center gap-4">
        <Cover
          src={entry?.coverUrl ?? media.coverUrl}
          fallbacks={entry?.coverFallbacks}
          className="w-14 shrink-0 shadow-none"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-display text-[28px] leading-none font-extrabold tracking-[-0.03em] md:text-[36px]">
            {t('settings.work.title')}
          </h1>
          <p className="text-muted truncate font-serif text-lg italic">
            {entry?.title ?? media.title}
          </p>
        </div>
      </header>
      <nav
        aria-label={t('settings.work.title')}
        className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0"
      >
        {sections.map((s) => (
          <button
            key={s}
            type="button"
            aria-current={s === section ? 'page' : undefined}
            onClick={() => go(s)}
            className={cx(
              'h-9 shrink-0 rounded-full px-4 text-sm',
              s === section
                ? 'bg-fg text-bg font-semibold'
                : 'bg-white/[0.07] hover:bg-white/[0.1]',
            )}
          >
            {label(s)}
          </button>
        ))}
      </nav>
      <SaveStatus save={save} />
      {library.data === undefined ? (
        <Skeleton className="h-64" />
      ) : !entry ? (
        <div className="flex flex-col items-start gap-3 rounded-2xl bg-white/[0.04] p-4">
          <p className="text-mid">{t('match.trackFirst')}</p>
          <button
            type="button"
            className={smallButton}
            onClick={() =>
              run(() => send('/api/tracked', 'POST', { media, status: 'PLANNING', sources }))
            }
          >
            {t('match.addToLibrary')}
          </button>
        </div>
      ) : section === 'general' ? (
        <GeneralTab entry={entry} media={media} sources={sources} run={run} patch={patch} />
      ) : section === 'catalog' ? (
        <CatalogTab
          entry={entry}
          media={media}
          onPick={(m) =>
            run(async () => {
              const u = await patch({ media: m });
              router.replace(`${mediaHref(u.media.id)}/settings?s=catalog`);
            })
          }
          onDetach={() =>
            run(async () => {
              const u = await patch({ offCatalog: true });
              router.replace(`${mediaHref(u.media.id)}/settings?s=catalog`);
            })
          }
        />
      ) : section === 'sources' ? (
        <SourcesTab
          entry={entry}
          sources={sources}
          lanes={scan.lanes}
          onScan={rescan}
          onSources={(next) => run(() => patch({ sources: next }))}
        />
      ) : section === 'kavita' ? (
        <KavitaTab
          entry={entry}
          media={media}
          onPick={(id) => run(() => patch({ kavitaSeriesId: id }))}
          onCoverSync={(kavitaCoverSync) => run(() => patch({ kavitaCoverSync }))}
        />
      ) : (
        <CoverTab
          entry={entry}
          media={media}
          onBackdrop={(backdrop) => run(() => patch({ backdrop }))}
          lanes={scan.lanes}
          sources={sources}
          onPick={(cover) => run(() => patch({ cover }))}
        />
      )}
    </main>
  );
}

/** Inline, polite save state: changes apply immediately, this only confirms them. */
function SaveStatus({ save }: { save: Save }) {
  const { t } = useI18n();
  return (
    <p aria-live="polite" className="text-muted -mt-2 flex min-h-5 items-center gap-2 text-xs">
      {save?.state === 'saving' && (
        <>
          <Spinner className="size-3" />
          {t('match.saving')}
        </>
      )}
      {save?.state === 'saved' && <span className="text-ok">✓ {t('match.saved')}</span>}
      {save?.state === 'error' && <span className="text-bad">{save.text}</span>}
      {!save && t('match.saveHint')}
    </p>
  );
}
