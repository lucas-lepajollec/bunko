'use client';
import { useState, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type { ChapterSelection, MediaDetail, TrackedMedia } from '@/types/shared';
import { send } from '@/lib/client/api';
import { clearPersistentCache } from '@/lib/client/cache';
import { useI18n } from '@/i18n/I18nProvider';
import { DisplayTitle } from './matches';
import { InfoBubble, toast } from './notify';
import { Segmented, cx, errorText, smallButton } from './ui';

/** Small labelled group of the settings page. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted text-xs tracking-[0.14em] uppercase">{title}</h2>
      {children}
    </section>
  );
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-fg' : 'bg-white/15',
      )}
    >
      <span
        className={cx(
          'absolute top-1 size-4 rounded-full transition-[left]',
          checked ? 'bg-bg left-6' : 'bg-fg left-1',
        )}
      />
    </button>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-white/[0.04] p-3 text-sm">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{title}</span>
        {hint && <span className="text-muted text-xs leading-relaxed">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * Everything about how Bunko treats this work: unit (chapters or volumes), owned files,
 * automatic downloads, 18+ classification and display title.
 */
export function GeneralTab({
  entry,
  media,
  sources,
  run,
  patch,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  sources: ChapterSelection[];
  run: (action: () => Promise<unknown>) => Promise<void>;
  patch: (body: object) => Promise<TrackedMedia>;
}) {
  const { t, n } = useI18n();
  const isComic = media.type === 'MANGA';
  const unit = entry.unit === 'volume' ? 'volume' : 'chapter';
  // Kavita files explicitly named as volumes ("Vol. 3", "Tome 3") without a chapter number.
  const detectedVolumes = entry.ownedAsVolumes ? 0 : (entry.ownedVolumes?.length ?? 0);
  const ownsFiles = (entry.ownedChapterCount ?? 0) > 0 || Boolean(entry.ownedAsVolumes);
  return (
    <div className="flex flex-col gap-8">
      {isComic && (
        <Group title={t('settings.work.collection')}>
          <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3 text-sm">
            <span className="flex items-center gap-2">
              {t('unit.label')}
              <InfoBubble label={t('unit.label')}>{t('settings.work.unitEditions')}</InfoBubble>
            </span>
            <Segmented
              value={unit}
              label={t('unit.label')}
              onChange={(next) => void run(() => patch({ unit: next }))}
              items={[
                { id: 'chapter', label: t('unit.chapter') },
                { id: 'volume', label: t('unit.volume') },
              ]}
            />
            <span className="text-muted text-xs leading-relaxed">
              {t(
                unit === 'volume'
                  ? 'settings.work.unitVolumeHint'
                  : 'settings.work.unitChapterHint',
              )}
            </span>
          </div>
          {unit === 'chapter' && detectedVolumes > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/[0.06] p-3 text-sm">
              <span>{t('settings.work.detectedVolumes', { n: n(detectedVolumes) })}</span>
              <button
                type="button"
                className={smallButton}
                onClick={() => void run(() => patch({ unit: 'volume' }))}
              >
                {t('settings.work.useVolumes')}
              </button>
            </div>
          )}
          {(unit === 'volume' || entry.ownedAsVolumes) && ownsFiles && (
            <Row title={t('unit.declareVolumes')} hint={t('settings.work.declareHint')}>
              <Switch
                label={t('unit.declareVolumes')}
                checked={Boolean(entry.ownedAsVolumes)}
                onChange={(ownedAsVolumes) => void run(() => patch({ ownedAsVolumes }))}
              />
            </Row>
          )}
          <Row
            title={t(unit === 'volume' ? 'settings.work.autoVolumes' : 'title.autoDownload')}
            hint={sources.length ? t('title.autoHint') : t('title.autoNeedsSource')}
          >
            <Switch
              label={t('title.autoDownload')}
              disabled={!sources.length}
              checked={entry.autoDownload ?? false}
              onChange={(autoDownload) => void run(() => patch({ autoDownload, sources }))}
            />
          </Row>
        </Group>
      )}
      <Group title={t('settings.work.content')}>
        <AdultSetting media={media} />
      </Group>
      <DisplayTitle entry={entry} onTitle={(displayTitle) => run(() => patch({ displayTitle }))} />
    </div>
  );
}

/** Marks a work 18+ (or unmarks a false positive); "Automatic" returns to provider data. */
export function AdultSetting({ media }: { media: MediaDetail }) {
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
    <Row
      title={t('adult.label')}
      hint={
        <>
          {t('adult.info')}
          {media.adultOverride != null && (
            <>
              {' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => set(null)}
                className="text-mid underline hover:text-white"
              >
                {t('adult.automatic')}
              </button>
            </>
          )}
        </>
      }
    >
      <Switch label={t('adult.label')} checked={adult} disabled={busy} onChange={(v) => set(v)} />
    </Row>
  );
}
