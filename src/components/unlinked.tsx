'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  ExtensionSection,
  PublicSettings,
  SearchResponse,
  TrackedMedia,
  UnlinkedItem,
} from '@/types/shared';
import { ApiFailure, mediaHref, send, useApi } from '@/lib/client/api';
import { KINDS, isVideoKind, kindsOf, type Kind } from '@/domain/kinds';
import { useI18n } from '@/i18n/I18nProvider';
import { IntegrationLogo, useIntegrationName } from './integration-logo';
import { CatalogPicker } from './relink';
import { toast } from './notify';
import { Cover, Empty, PosterSkeletons, cx, errorText, field, smallButton } from './ui';

type Open = { key: string; mode: 'link' | 'create' } | null;
const keyOf = (i: UnlinkedItem) => `${i.integration}:${i.id}`;

/**
 * What the integrations hold that no work of the library is linked to: each item is linked to a
 * catalog work (then fine-tuned in the work's Links), followed as found (Kavita's own match), made
 * a work of its own of any kind, or ignored.
 */
export function UnlinkedInbox({
  items,
  onChanged,
}: {
  items: UnlinkedItem[] | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const { t, n } = useI18n();
  const integrationName = useIntegrationName();
  const [integration, setIntegration] = useState<UnlinkedItem['integration'] | 'all'>('all');
  const [showIgnored, setShowIgnored] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = (items ?? []).filter(
    (i) => (integration === 'all' || i.integration === integration) && i.ignored === showIgnored,
  );
  const integrations = (['jellyfin', 'stash', 'kavita'] as const).filter((x) =>
    (items ?? []).some((i) => i.integration === x),
  );
  const count = (x: UnlinkedItem['integration']) =>
    (items ?? []).filter((i) => i.integration === x && !i.ignored).length;

  async function act(item: UnlinkedItem, action: () => Promise<unknown>) {
    setBusy(keyOf(item));
    try {
      await action();
      await onChanged();
      setOpen(null);
    } catch (e) {
      toast({
        tone: 'bad',
        text:
          e instanceof ApiFailure && e.code === 'NO_MATCH' ? t('kavita.noMatch') : errorText(t, e),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-mid max-w-3xl text-sm leading-relaxed">{t('unlinked.hint')}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FilterChip on={integration === 'all'} onClick={() => setIntegration('all')}>
          {t('unlinked.all')}
        </FilterChip>
        {integrations.map((x) => (
          <FilterChip key={x} on={integration === x} onClick={() => setIntegration(x)}>
            <IntegrationLogo id={x} className="size-5" />
            {integrationName(x)}
            <span className="opacity-70">{n(count(x))}</span>
          </FilterChip>
        ))}
        <span className="flex-1" />
        <FilterChip on={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
          {t('unlinked.ignored')}
        </FilterChip>
      </div>
      {!items && <PosterSkeletons count={4} />}
      {items && shown.length === 0 && (
        <Empty title={showIgnored ? t('unlinked.noneIgnored') : t('unlinked.none')} />
      )}
      <ul className="flex flex-col gap-2.5">
        {shown.map((item) => {
          const key = keyOf(item);
          const isOpen = open?.key === key;
          return (
            <li key={key} className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-3 md:p-4">
              <div className="flex flex-wrap items-center gap-3 md:gap-4">
                <Cover src={item.coverUrl} alt="" className="w-12 shrink-0 shadow-none md:w-14" />
                <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
                  <span className="truncate font-semibold" title={item.name}>
                    {item.name}
                  </span>
                  <span className="text-muted flex flex-wrap items-center gap-x-2 text-xs">
                    <IntegrationLogo id={item.integration} className="size-4" />
                    {[
                      integrationName(item.integration),
                      item.library,
                      item.year,
                      t(isVideoKind(item.kind) ? 'unlinked.items' : 'unlinked.chapters', {
                        n: n(item.count),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <span className="flex flex-wrap gap-2">
                  {item.integration === 'kavita' && !item.ignored && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      className={cx(smallButton, 'bg-fg text-bg font-semibold')}
                      onClick={() =>
                        void act(item, () =>
                          send('/api/kavita/track', 'POST', { seriesId: Number(item.id) }),
                        )
                      }
                    >
                      {busy === key ? t('common.working') : t('unlinked.follow')}
                    </button>
                  )}
                  {!item.ignored && (
                    <>
                      <button
                        type="button"
                        aria-expanded={isOpen && open.mode === 'link'}
                        className={smallButton}
                        onClick={() =>
                          setOpen(isOpen && open.mode === 'link' ? null : { key, mode: 'link' })
                        }
                      >
                        {t('unlinked.linkTo')}
                      </button>
                      <button
                        type="button"
                        aria-expanded={isOpen && open.mode === 'create'}
                        className={smallButton}
                        onClick={() =>
                          setOpen(isOpen && open.mode === 'create' ? null : { key, mode: 'create' })
                        }
                      >
                        {t('unlinked.create')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={busy !== null}
                    className={smallButton}
                    onClick={() =>
                      void act(item, () =>
                        send('/api/unlinked', 'PATCH', {
                          integration: item.integration,
                          id: item.id,
                          ignored: !item.ignored,
                        }),
                      )
                    }
                  >
                    {item.ignored ? t('unlinked.restore') : t('unlinked.ignore')}
                  </button>
                </span>
              </div>
              {isOpen && open.mode === 'link' && (
                <LinkToWork item={item} busy={busy !== null} onDone={act} />
              )}
              {isOpen && open.mode === 'create' && (
                <CreateSheet item={item} busy={busy !== null} onDone={act} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'flex h-9 items-center gap-2 rounded-full px-3.5',
        on ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.06] hover:bg-white/[0.1]',
      )}
    >
      {children}
    </button>
  );
}

type Act = (item: UnlinkedItem, action: () => Promise<unknown>) => Promise<void>;

/** Pick a catalog work: it is followed (if not yet) and linked to the item. */
function LinkToWork({ item, busy, onDone }: { item: UnlinkedItem; busy: boolean; onDone: Act }) {
  const router = useRouter();
  const pick = (m: SearchResponse['results'][number]) =>
    void onDone(item, async () => {
      const entry = await send<TrackedMedia>('/api/tracked', 'POST', {
        media: m,
        status: 'PLANNING',
      });
      if (item.integration === 'stash')
        await send('/api/tracked', 'PATCH', { id: entry.id, stashLink: item.id });
      else if (item.integration === 'jellyfin') {
        await send('/api/tracked', 'PATCH', {
          id: entry.id,
          jellyfinLink: { seriesId: item.id, season: 1 },
        });
        // Episodes are fine-tuned in the work's Links.
        router.push(`${mediaHref(entry.media.id)}/settings?s=jellyfin`);
      } else await send('/api/tracked', 'PATCH', { id: entry.id, kavitaSeriesId: Number(item.id) });
    });
  return (
    <div className={cx(busy && 'pointer-events-none opacity-60')}>
      <CatalogPicker initial={item.name} onPick={pick} kind={item.kind} />
    </div>
  );
}

/** Make the item a work of its own: kind (extension sections too), title, year. */
function CreateSheet({ item, busy, onDone }: { item: UnlinkedItem; busy: boolean; onDone: Act }) {
  const { t } = useI18n();
  const router = useRouter();
  const settings = useApi<PublicSettings>('/api/settings');
  const video = isVideoKind(item.kind);
  const kinds = kindsOf(video ? 'video' : 'reading').filter((k) => k !== 'extension');
  // Sections the extensions declare (their names and their own 18+ flag), for video items.
  const sections: ExtensionSection[] = video ? (settings.data?.extensionSections ?? []) : [];
  const [kind, setKind] = useState<Kind>(item.kind);
  const [section, setSection] = useState<ExtensionSection | null>(null);
  const [title, setTitle] = useState(item.name);
  const [year, setYear] = useState(item.year ? String(item.year) : '');
  const yearNumber = /^\d{4}$/.test(year) ? Number(year) : null;
  // 18+: on by default in the 18+ mode (where it is made), and always for a section its extension
  // declares 18+, so the work shows where it was filed.
  const adultMode = Boolean(settings.data?.adultContent && settings.data?.adultMode);
  const [adultChoice, setAdultChoice] = useState<boolean | null>(null);
  const sectionAdult = kind === 'extension' && Boolean(section?.adult);
  const adult = sectionAdult || (adultChoice ?? adultMode);
  const create = () =>
    void onDone(item, async () => {
      const entry = await send<TrackedMedia>('/api/unlinked', 'POST', {
        integration: item.integration,
        id: item.id,
        kind,
        title: title.trim(),
        year: yearNumber,
        section: kind === 'extension' && section ? { id: section.id, name: section.name } : null,
        adult,
      });
      router.push(mediaHref(entry.media.id));
    });
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-white/[0.04] p-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">{t('unlinked.kind')}</span>
        <div className="flex flex-wrap gap-2">
          {kinds.map((k) => (
            <KindChip
              key={k}
              on={kind === k}
              onClick={() => {
                setKind(k);
                setSection(null);
              }}
            >
              {t(`kind.${k}`)}
            </KindChip>
          ))}
          {sections.map((s) => (
            <KindChip
              key={s.id}
              on={kind === 'extension' && section?.id === s.id}
              onClick={() => {
                setKind('extension');
                setSection(s);
              }}
            >
              {s.name}
            </KindChip>
          ))}
        </div>
        {sections.length > 0 && (
          <span className="text-muted text-xs">{t('unlinked.kindHint')}</span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          {t('unlinked.title')}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            className={cx(field, 'h-10 font-normal')}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          {t('unlinked.year')}
          <input
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            className={cx(field, 'h-10 font-normal')}
          />
        </label>
      </div>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{t('unlinked.adult')}</span>
          <span className="text-muted text-xs">
            {sectionAdult ? t('unlinked.adultSection') : t('unlinked.adultHint')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={adult}
          disabled={sectionAdult}
          onChange={(e) => setAdultChoice(e.target.checked)}
          className="accent-fg size-[18px] shrink-0"
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted text-xs">
          {t(
            KINDS[kind].family === 'video'
              ? 'unlinked.createHint.video'
              : 'unlinked.createHint.read',
          )}
        </span>
        <button
          type="button"
          disabled={busy || !title.trim() || (kind === 'extension' && !section)}
          onClick={create}
          className={cx(smallButton, 'bg-fg text-bg font-semibold disabled:opacity-50')}
        >
          {t('unlinked.createConfirm')}
        </button>
      </div>
    </div>
  );
}

function KindChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'h-9 rounded-full px-4 text-sm',
        on ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.06] hover:bg-white/[0.1]',
      )}
    >
      {children}
    </button>
  );
}
