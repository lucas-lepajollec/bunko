'use client';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type { PublicSettings, SecretSetting, ServicesStatus, SettingsPatch } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { LanguageSelect, Page } from '@/components/shell';
import {
  Dot,
  ErrorNote,
  Skeleton,
  cx,
  errorText,
  field,
  roman,
  smallButton,
} from '@/components/ui';

const SECTIONS = ['connections', 'downloads', 'display', 'sources', 'modules', 'access'] as const;
type Settings = PublicSettings & { updateIntervalMinutes?: number };

export default function SettingsPage() {
  const { t } = useI18n();
  const settings = useApi<Settings>('/api/settings');
  const status = useApi<ServicesStatus>('/api/status');
  return (
    <Page className="pb-20 md:grid md:grid-cols-[260px_minmax(0,1fr)] md:gap-20">
      <nav
        aria-label={t('settings.sections')}
        className="flex flex-col md:sticky md:top-28 md:self-start"
      >
        <h1 className="font-display mb-4 text-[40px] leading-none font-extrabold tracking-[-0.04em] md:mb-6 md:text-[52px]">
          {t('nav.settings')}
        </h1>
        <div className="no-scrollbar -mx-4 flex gap-5 overflow-x-auto px-4 md:mx-0 md:flex-col md:gap-0 md:px-0">
          {SECTIONS.map((s, i) => (
            <a
              key={s}
              href={`#${s}`}
              className="md:border-line text-mid flex shrink-0 items-baseline gap-3.5 py-2 hover:text-white md:border-b md:py-2.5"
            >
              <span className="text-muted hidden w-[30px] font-serif text-lg md:inline">
                {roman(i + 1)}
              </span>
              <span className="text-[15px]">{t(`settings.section.${s}`)}</span>
            </a>
          ))}
        </div>
      </nav>
      <div className="mt-6 flex max-w-[860px] min-w-0 flex-col gap-14 md:mt-0">
        {settings.error && <ErrorNote error={settings.error} />}
        {!settings.data ? (
          <Skeleton className="h-96 rounded-2xl" />
        ) : (
          <>
            <Section id="connections" index={1}>
              <Connections
                settings={settings.data}
                status={status.data}
                onSaved={() => Promise.all([settings.mutate(), status.mutate()])}
              />
            </Section>
            <Section id="downloads" index={2}>
              <Downloads
                settings={settings.data}
                onSaved={(s) => settings.mutate(s, { revalidate: false })}
              />
            </Section>
            <Section id="display" index={3}>
              <Row label={t('settings.language')} tip={t('settings.languageTip')}>
                <LanguageSelect className="h-11 px-4" />
              </Row>
            </Section>
            <Section id="sources" index={4}>
              <p className="text-mid text-sm leading-relaxed">{t('settings.sourcesBody')}</p>
              <Link href="/sources" className={cx(smallButton, 'self-start')}>
                {t('settings.manageSources')} →
              </Link>
            </Section>
            <Section id="modules" index={5}>
              <Modules />
            </Section>
            <Section id="access" index={6}>
              <Access />
            </Section>
          </>
        )}
      </div>
    </Page>
  );
}

function Section({
  id,
  index,
  children,
}: {
  id: (typeof SECTIONS)[number];
  index: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-28 flex-col gap-[18px]"
    >
      <div className="flex items-baseline gap-4">
        <span className="text-muted font-serif text-xl">{roman(index)}</span>
        <h2
          id={`${id}-title`}
          className="font-display text-[26px] font-bold tracking-[-0.02em] md:text-[30px]"
        >
          {t(`settings.section.${id}`)}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Tip({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      className="border-line-strong text-muted inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-serif text-sm italic"
    >
      i
    </span>
  );
}

function Row({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-6">
      <span className="flex items-center gap-2 text-sm">
        {label}
        {tip && <Tip text={tip} />}
      </span>
      {children}
    </div>
  );
}

function Connections({
  settings,
  status,
  onSaved,
}: {
  settings: Settings;
  status: ServicesStatus | undefined;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const services: {
    key: 'suwayomi' | 'kavita';
    fields: {
      name: keyof SettingsPatch;
      label: string;
      type?: string;
      secret?: SecretSetting;
      options?: string[];
    }[];
    state: string | undefined;
    detail?: string | null;
  }[] = [
    {
      key: 'suwayomi',
      state: status?.suwayomi.state,
      detail: status?.suwayomi.version ? `v${status.suwayomi.version}` : null,
      fields: [
        { name: 'suwayomiUrl', label: t('settings.address'), type: 'url' },
        { name: 'suwayomiUsername', label: t('settings.username') },
        {
          name: 'suwayomiPassword',
          label: t('settings.password'),
          type: 'password',
          secret: 'suwayomiPassword',
        },
      ],
    },
    {
      key: 'kavita',
      state: status?.kavita.state,
      fields: [
        { name: 'kavitaUrl', label: t('settings.address'), type: 'url' },
        {
          name: 'kavitaApiKey',
          label: t('settings.apiKey'),
          type: 'password',
          secret: 'kavitaApiKey',
        },
        { name: 'kavitaLibraryPath', label: t('settings.libraryPath') },
        { name: 'kavitaAuthMode', label: t('settings.authMode'), options: ['api-key', 'jwt'] },
      ],
    },
  ];
  return (
    <>
      {services.map((s) => (
        <ServiceCard
          key={s.key}
          name={s.key}
          state={s.state}
          detail={s.detail}
          fields={s.fields}
          settings={settings}
          onSaved={onSaved}
        />
      ))}
    </>
  );
}

function ServiceCard({
  name,
  state,
  detail,
  fields,
  settings,
  onSaved,
}: {
  name: 'suwayomi' | 'kavita';
  state: string | undefined;
  detail?: string | null;
  fields: {
    name: keyof SettingsPatch;
    label: string;
    type?: string;
    secret?: SecretSetting;
    options?: string[];
  }[];
  settings: Settings;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = (f: (typeof fields)[number]) =>
    draft[f.name] ??
    (f.secret ? '' : String((settings as unknown as Record<string, unknown>)[f.name] ?? ''));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const patch = Object.fromEntries(
        Object.entries(draft).filter(
          ([k, v]) => !(fields.find((f) => f.name === k)?.secret && v === ''),
        ),
      );
      if (Object.keys(patch).length) await send('/api/settings', 'PATCH', patch);
      setDraft({});
      await onSaved();
      void mutate((key) => typeof key === 'string' && key.startsWith('/api/'));
      setSaved(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }
  const tone = state === 'ok' ? 'ok' : state === 'error' ? 'bad' : 'idle';
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-lg font-semibold">{t(`settings.service.${name}`)}</span>
        <span className="text-mid flex items-center gap-2 text-[13px]">
          <Dot tone={tone} />
          {state ? t(`settings.state.${state}`) : '…'}
          {detail ? ` · ${detail}` : ''}
        </span>
        <Tip text={t(`settings.service.${name}Tip`)} />
      </div>
      <div className="grid gap-3.5 md:grid-cols-2">
        {fields.map((f) => (
          <label key={f.name} className="text-muted flex flex-col gap-1.5 text-[13px]">
            {f.label}
            {f.options ? (
              <select
                value={value(f)}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                className={field}
              >
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {t(`settings.authMode.${o}`)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type ?? 'text'}
                value={value(f)}
                autoComplete={f.secret ? 'new-password' : 'off'}
                placeholder={
                  f.secret && settings.secretsConfigured[f.secret] ? t('settings.secretSet') : ''
                }
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                className={field}
              />
            )}
            {f.secret && settings.secretsConfigured[f.secret] && (
              <button
                type="button"
                onClick={async () => {
                  await send('/api/settings', 'PATCH', { [f.name]: '' }).catch(() => undefined);
                  await onSaved();
                }}
                className="text-muted self-start text-xs underline hover:text-white"
              >
                {t('settings.clearSecret')}
              </button>
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="bg-fg text-bg h-10 rounded-full px-5 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? t('common.working') : t('settings.saveAndTest')}
        </button>
        {saved && !error && <span className="text-ok text-sm">{t('settings.saved')}</span>}
        {error && <span className="text-bad text-sm">{error}</span>}
      </div>
    </form>
  );
}

function Downloads({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { t } = useI18n();
  const [minutes, setMinutes] = useState(String(settings.updateIntervalMinutes ?? 15));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <Row label={t('settings.interval')} tip={t('settings.intervalTip')}>
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              onSaved(
                await send<Settings>('/api/settings', 'PATCH', {
                  updateIntervalMinutes: Number(minutes),
                }),
              );
            } catch (err) {
              setError(errorText(t, err));
            }
          }}
        >
          <input
            type="number"
            min={5}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-label={t('settings.interval')}
            className={cx(field, 'w-24 text-center')}
          />
          <span className="text-muted">{t('settings.minutes')}</span>
          <button type="submit" className={smallButton}>
            {t('common.save')}
          </button>
        </form>
      </Row>
      {error && <p className="text-bad">{error}</p>}
      <Row label={t('settings.format')} tip={t('settings.formatTip')}>
        <span className="text-mid">CBZ + ComicInfo</span>
      </Row>
    </div>
  );
}

function Modules() {
  const { t } = useI18n();
  const modules = [
    { key: 'scans', tone: 'ok' as const },
    { key: 'novels', tone: 'warn' as const },
    { key: 'video', tone: 'idle' as const },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {modules.map((m) => (
        <div
          key={m.key}
          className={cx(
            'flex flex-col gap-2.5 rounded-[18px] border p-5',
            m.key === 'scans'
              ? 'border-line-strong bg-white/[0.06]'
              : 'border-line bg-white/[0.03]',
          )}
        >
          <span className="font-display text-[22px] font-bold">
            {t(`settings.module.${m.key}`)}
          </span>
          <span className="text-mid font-serif text-lg leading-snug italic">
            {t(`settings.module.${m.key}Chain`)}
          </span>
          <span className="text-mid mt-2 flex items-center gap-2 text-[13px]">
            <Dot tone={m.tone} />
            {t(`settings.module.${m.key}State`)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Access() {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-mid leading-relaxed">{t('settings.accessBody')}</p>
      <button
        type="button"
        onClick={async () => {
          await send('/api/auth', 'DELETE').catch(() => undefined);
          await mutate('/api/auth');
        }}
        className={cx(smallButton, 'self-start')}
      >
        {t('settings.signOut')}
      </button>
    </div>
  );
}
