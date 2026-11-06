'use client';
import { Select } from '@/components/select';
import { clearPersistentCache } from '@/lib/client/cache';
import Link from 'next/link';
import { InfoBubble, Notice, toast } from '@/components/notify';
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type {
  AuthState,
  CatalogProvider,
  KavitaIndexStatus,
  MyAccount,
  MyAccountPatch,
  UserAccount,
  UserCreate,
  UserPatch,
  UserRole,
  KavitaLibrary,
  LibraryKind,
  LibraryTargets,
  PublicSettings,
  SecretSetting,
  ServicesStatus,
  SettingsPatch,
} from '@/types/shared';
import { PERMISSIONS } from '@/types/shared';
import type { ArrOptions, JellyfinLibrary, JellyfinRole, LiveStatus } from '@/types/shared';
import { UNIVERSES } from '@/lib/client/universe';
import { KIND_IDS, KINDS as KIND_DEFS, completeKindOrder, isVideoKind } from '@/domain/kinds';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { LanguageSelect, Page } from '@/components/shell';
import { useRelativeTime } from '@/components/time';
import { Dot, ErrorNote, Skeleton, cx, errorText, field, smallButton } from '@/components/ui';

/**
 * Settings by what they are about: the user's own account and media, accounts (admins), each
 * external service with its connection and its options together, then catalogs and streaming.
 */
const GROUPS = [
  { id: 'personal', sections: ['account', 'media'] },
  { id: 'admin', sections: ['users'] },
  { id: 'services', sections: ['suwayomi', 'kavita', 'jellyfin', 'arr', 'translation'] },
  { id: 'content', sections: ['catalogs', 'extensions', 'live'] },
] as const;
type SectionId = (typeof GROUPS)[number]['sections'][number];
const SECTIONS: readonly SectionId[] = GROUPS.flatMap((g) => g.sections);
/** Earlier links (#connections, #downloads…) open the section that now holds them. */
const ALIASES: Record<string, SectionId> = {
  connections: 'suwayomi',
  downloads: 'suwayomi',
  sources: 'suwayomi',
  display: 'account',
  modules: 'media',
  video: 'extensions',
};
/** Every user configures their own instance; only admins also manage accounts. */
const MEMBER_SECTIONS: readonly SectionId[] = SECTIONS.filter((s) => s !== 'users');
type Settings = PublicSettings & { updateIntervalMinutes?: number };

const subscribeHash = (l: () => void) => {
  window.addEventListener('hashchange', l);
  return () => window.removeEventListener('hashchange', l);
};

export default function SettingsPage() {
  const { t } = useI18n();
  // Phones show the list of sections first, then one section with a back button; a link such as
  // /settings#kavita opens that section directly. Desktop shows the chosen section beside the list.
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash.slice(1),
    () => '',
  );
  const [picked, setPicked] = useState<SectionId | null | undefined>(undefined);
  const auth = useApi<AuthState>('/api/auth');
  const visible: readonly SectionId[] = auth.data?.role === 'member' ? MEMBER_SECTIONS : SECTIONS;
  const fromHash = ALIASES[hash] ?? hash;
  const open: SectionId | null =
    picked !== undefined
      ? picked
      : (visible as readonly string[]).includes(fromHash)
        ? (fromHash as SectionId)
        : null;
  const settings = useApi<Settings>('/api/settings', { revalidateOnFocus: true });
  const status = useApi<ServicesStatus>('/api/status');
  const reload = () => Promise.all([settings.mutate(), status.mutate()]);
  const keep = (s: Settings) => settings.mutate(s, { revalidate: false });
  const current = open ?? visible[0];
  return (
    <Page className="pb-20 md:grid md:grid-cols-[240px_minmax(0,1fr)] md:gap-16">
      <nav
        aria-label={t('settings.sections')}
        className={cx(
          'flex-col md:sticky md:top-28 md:flex md:self-start',
          open ? 'hidden' : 'flex',
        )}
      >
        <h1 className="font-display mb-6 text-[40px] leading-none font-extrabold tracking-[-0.04em] md:text-[44px]">
          {t('nav.settings')}
        </h1>
        <div className="flex flex-col gap-6">
          {GROUPS.map((g) => {
            const items = g.sections.filter((s) => visible.includes(s));
            if (!items.length) return null;
            return (
              <div key={g.id} className="flex flex-col">
                <span className="text-muted mb-1.5 px-3 text-xs font-medium tracking-[0.06em] uppercase">
                  {t(`settings.group.${g.id}`)}
                </span>
                <div className="flex flex-col overflow-hidden rounded-2xl bg-white/[0.04] md:bg-transparent">
                  {items.map((s) => (
                    <a
                      key={s}
                      href={`#${s}`}
                      aria-current={current === s ? 'page' : undefined}
                      onClick={(e) => {
                        // One section at a time on every screen; the hash keeps it linkable.
                        e.preventDefault();
                        setPicked(s);
                        history.replaceState(null, '', `#${s}`);
                        window.scrollTo(0, 0);
                      }}
                      className={cx(
                        'border-line flex min-h-[52px] items-center gap-3 border-b px-3 last:border-b-0 hover:text-white md:min-h-10 md:rounded-xl md:border-b-0',
                        current === s
                          ? 'md:bg-white/[0.07] md:font-semibold md:text-white'
                          : 'text-mid',
                      )}
                    >
                      <span className="flex-1 text-[16px] md:text-[15px]">
                        {t(`settings.section.${s}`)}
                      </span>
                      <ServiceDot section={s} status={status.data} />
                      <span aria-hidden className="text-muted md:hidden">
                        ›
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </nav>
      <div
        className={cx(
          'max-w-[860px] min-w-0 flex-col gap-14 md:mt-0 md:flex',
          open ? 'flex' : 'hidden',
        )}
      >
        <button
          type="button"
          onClick={() => {
            setPicked(null);
            if (window.location.hash) history.replaceState(null, '', window.location.pathname);
          }}
          className="text-mid -mb-8 flex items-center gap-2 self-start text-[15px] hover:text-white md:hidden"
        >
          <span aria-hidden>‹</span> {t('nav.settings')}
        </button>
        <Section open={open} visible={visible} id="account">
          <Account />
        </Section>
        <Section open={open} visible={visible} id="media">
          <UniverseSettings />
        </Section>
        {visible.includes('users') && (
          <Section open={open} visible={visible} id="users">
            <Users />
          </Section>
        )}
        {settings.error ? (
          <ErrorNote error={settings.error} />
        ) : !settings.data ? (
          current !== 'account' &&
          current !== 'media' &&
          current !== 'users' && <Skeleton className="h-96 rounded-2xl" />
        ) : (
          <>
            <Section open={open} visible={visible} id="suwayomi">
              <Connection
                service="suwayomi"
                settings={settings.data}
                status={status.data}
                onSaved={reload}
              />
              {settings.data.suwayomiUrl && (
                <>
                  <SubHeading>{t('settings.section.downloads')}</SubHeading>
                  <Downloads settings={settings.data} onSaved={keep} />
                  <SubHeading>{t('settings.section.sources')}</SubHeading>
                  <p className="text-mid text-sm leading-relaxed">{t('settings.sourcesBody')}</p>
                  <Link href="/sources" className={cx(smallButton, 'self-start')}>
                    {t('settings.manageSources')} →
                  </Link>
                </>
              )}
            </Section>
            <Section open={open} visible={visible} id="kavita">
              <Connection
                service="kavita"
                settings={settings.data}
                status={status.data}
                onSaved={reload}
              />
              {settings.data.kavitaUrl && (
                <>
                  <SubHeading>{t('settings.section.kavitaLibraries')}</SubHeading>
                  <KavitaTargets
                    admin={status.data?.kavita.admin ?? null}
                    settings={settings.data}
                    onSaved={keep}
                  />
                </>
              )}
            </Section>
            <Section open={open} visible={visible} id="jellyfin">
              <Connection
                service="jellyfin"
                settings={settings.data}
                status={status.data}
                onSaved={reload}
              />
              {status.data?.jellyfin?.state && status.data.jellyfin.state !== 'unconfigured' && (
                <JellyfinOptions settings={settings.data} onSaved={reload} />
              )}
            </Section>
            <Section open={open} visible={visible} id="arr">
              <p className="text-mid text-sm leading-relaxed">{t('arr.intro')}</p>
              {(['sonarr', 'radarr'] as const).map((service) => (
                <div key={service} className="flex flex-col gap-3">
                  <SubHeading>{t(`settings.service.${service}`)}</SubHeading>
                  <Connection
                    service={service}
                    settings={settings.data!}
                    status={status.data}
                    onSaved={reload}
                  />
                  {status.data?.[service]?.state === 'ok' && (
                    <ArrChoices service={service} settings={settings.data!} onSaved={reload} />
                  )}
                </div>
              ))}
              {(['prowlarr', 'qbittorrent'] as const).map((service) => (
                <div key={service} className="flex flex-col gap-3">
                  <SubHeading>{t(`settings.service.${service}`)}</SubHeading>
                  <Connection
                    service={service}
                    settings={settings.data!}
                    status={status.data}
                    onSaved={reload}
                  />
                </div>
              ))}
            </Section>
            <Section open={open} visible={visible} id="translation">
              <Connection
                service="tradoc"
                settings={settings.data}
                status={status.data}
                onSaved={reload}
              />
            </Section>
            <Section open={open} visible={visible} id="catalogs">
              <Catalogs settings={settings.data} onSaved={keep} />
            </Section>
            <Section open={open} visible={visible} id="extensions">
              <ExtensionsSummary settings={settings.data} status={status.data} />
            </Section>
            <Section open={open} visible={visible} id="live">
              <LiveSettings settings={settings.data} onSaved={keep} />
            </Section>
          </>
        )}
      </div>
    </Page>
  );
}

/** A service's state beside its name in the list (green connected, red failing). */
function ServiceDot({
  section,
  status,
}: {
  section: SectionId;
  status: ServicesStatus | undefined;
}) {
  const key = section === 'translation' ? 'tradoc' : section;
  if (!['suwayomi', 'kavita', 'jellyfin', 'tradoc', 'arr'].includes(key) || !status) return null;
  const states = status as unknown as Record<string, { state?: string } | undefined>;
  // Sonarr & Radarr share one entry: red if either fails, green if one works.
  const arr = [
    states.sonarr?.state,
    states.radarr?.state,
    states.prowlarr?.state,
    states.qbittorrent?.state,
  ].filter((x) => x && x !== 'unconfigured');
  const state =
    key === 'arr'
      ? arr.includes('error')
        ? 'error'
        : arr.includes('ok')
          ? 'ok'
          : undefined
      : states[key]?.state;
  if (!state || state === 'unconfigured') return null;
  return <Dot tone={state === 'ok' ? 'ok' : state === 'error' ? 'bad' : 'idle'} />;
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 text-[17px] font-semibold">{children}</h3>;
}

function Section({
  open,
  visible,
  id,
  children,
}: {
  open: SectionId | null;
  visible: readonly SectionId[];
  id: SectionId;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cx(
        'scroll-mt-28 flex-col gap-[18px]',
        open === id ? 'flex' : 'hidden',
        (open ?? visible[0]) === id ? 'md:flex' : 'md:hidden',
      )}
    >
      <h2
        id={`${id}-title`}
        className="font-display text-[26px] font-bold tracking-[-0.02em] md:text-[30px]"
      >
        {t(`settings.section.${id}`)}
      </h2>
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

/** One service's connection form (address, keys) with its live state. */
function Connection({
  service,
  settings,
  status,
  onSaved,
}: {
  service:
    | 'suwayomi'
    | 'kavita'
    | 'tradoc'
    | 'jellyfin'
    | 'sonarr'
    | 'radarr'
    | 'prowlarr'
    | 'qbittorrent';
  settings: Settings;
  status: ServicesStatus | undefined;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const services: {
    key:
      | 'suwayomi'
      | 'kavita'
      | 'tradoc'
      | 'jellyfin'
      | 'sonarr'
      | 'radarr'
      | 'prowlarr'
      | 'qbittorrent';
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
        { name: 'kavitaLibraryPath', label: t('settings.libraryPathOptional') },
        { name: 'kavitaAuthMode', label: t('settings.authMode'), options: ['api-key', 'jwt'] },
      ],
    },
    {
      key: 'jellyfin',
      state: status?.jellyfin?.state,
      detail: status?.jellyfin?.version ? `v${status.jellyfin.version}` : null,
      fields: [
        { name: 'jellyfinUrl', label: t('settings.address'), type: 'url' },
        {
          name: 'jellyfinApiKey',
          label: t('settings.apiKey'),
          type: 'password',
          secret: 'jellyfinApiKey',
        },
        { name: 'jellyfinUser', label: t('settings.jellyfinUser') },
      ],
    },
    ...(['sonarr', 'radarr', 'prowlarr'] as const).map((key) => ({
      key,
      state: status?.[key]?.state,
      detail: status?.[key]?.version ? `v${status[key]!.version}` : null,
      fields: [
        { name: `${key}Url` as keyof SettingsPatch, label: t('settings.address'), type: 'url' },
        {
          name: `${key}ApiKey` as keyof SettingsPatch,
          label: t('settings.apiKey'),
          type: 'password',
          secret: `${key}ApiKey` as SecretSetting,
        },
      ],
    })),
    {
      key: 'qbittorrent',
      state: status?.qbittorrent?.state,
      detail: status?.qbittorrent?.version ?? null,
      fields: [
        { name: 'qbittorrentUrl', label: t('settings.address'), type: 'url' },
        {
          name: 'qbittorrentApiKey',
          label: t('settings.qbittorrentApiKey'),
          type: 'password',
          secret: 'qbittorrentApiKey',
        },
        { name: 'qbittorrentUsername', label: t('settings.qbittorrentUsername') },
        {
          name: 'qbittorrentPassword',
          label: t('settings.password'),
          type: 'password',
          secret: 'qbittorrentPassword',
        },
      ],
    },
    {
      key: 'tradoc',
      state: status?.tradoc?.state,
      detail: status?.tradoc?.version ? `v${status.tradoc.version}` : null,
      fields: [
        { name: 'tradocUrl', label: t('settings.tradocAddress'), type: 'url' },
        {
          name: 'tradocApiKey',
          label: t('settings.tradocKey'),
          type: 'password',
          secret: 'tradocApiKey',
        },
      ],
    },
  ];
  const s = services.find((x) => x.key === service)!;
  return (
    <ServiceCard
      name={s.key}
      state={s.state}
      detail={s.detail}
      fields={s.fields}
      settings={settings}
      onSaved={onSaved}
    />
  );
}

/** Automatic import of Jellyfin anime, and an immediate re-read of the library. */
function JellyfinOptions({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const libraries = useApi<JellyfinLibrary[]>('/api/jellyfin/libraries');
  const roles: JellyfinRole[] = ['anime', 'series', 'movies', 'animation', 'ignore'];
  return (
    <div className="flex flex-col gap-2 px-1 text-sm">
      {libraries.data && libraries.data.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-white/[0.03] p-3">
          <span className="font-medium">{t('jellyfin.libraries')}</span>
          <span className="text-muted text-xs leading-relaxed">{t('jellyfin.librariesHint')}</span>
          {libraries.data.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="flex flex-col">
                <span>{l.name}</span>
                {l.role !== l.detected && (
                  <span className="text-muted text-xs">
                    {t('jellyfin.detected', { role: t(`jellyfin.role.${l.detected}`) })}
                  </span>
                )}
              </span>
              <Select
                label={t('jellyfin.libraryRole', { name: l.name })}
                value={l.role}
                onChange={async (role) => {
                  try {
                    await send('/api/settings', 'PATCH', {
                      jellyfinLibraries: {
                        ...settings.jellyfinLibraries,
                        [l.id]: role as JellyfinRole,
                      },
                    });
                    await Promise.all([onSaved(), libraries.mutate()]);
                  } catch (err) {
                    toast({ tone: 'bad', text: errorText(t, err) });
                  }
                }}
                options={roles.map((r) => ({ value: r, label: t(`jellyfin.role.${r}`) }))}
              />
            </div>
          ))}
        </div>
      )}
      <Row label={t('jellyfin.autoImport')} tip={t('jellyfin.autoImportTip')}>
        <input
          type="checkbox"
          checked={settings.autoImportJellyfin ?? true}
          onChange={async (e) => {
            try {
              await send('/api/settings', 'PATCH', { autoImportJellyfin: e.target.checked });
              await onSaved();
            } catch (err) {
              toast({ tone: 'bad', text: errorText(t, err) });
            }
          }}
          className="accent-fg size-[18px]"
        />
      </Row>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await send('/api/jellyfin/sync', 'POST');
            toast({ tone: 'ok', text: t('jellyfin.synced') });
          } catch (err) {
            toast({ tone: 'bad', text: errorText(t, err) });
          } finally {
            setBusy(false);
          }
        }}
        className={cx(smallButton, 'self-start')}
      >
        {busy ? t('common.working') : t('jellyfin.syncNow')}
      </button>
      <JellyfinDisconnect onSaved={onSaved} />
    </div>
  );
}

/** Disconnect Jellyfin, asking whether the works it added should leave the library too. */
function JellyfinDisconnect({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const { t, n } = useI18n();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const imported = useApi<{ imported: number }>(asking ? '/api/jellyfin/disconnect' : null);
  const go = async (removeImported: boolean) => {
    setBusy(true);
    try {
      const done = await send<{ removed: number }>('/api/jellyfin/disconnect', 'POST', {
        removeImported,
      });
      toast({
        tone: 'ok',
        text: removeImported
          ? t('jellyfin.disconnectedRemoved', { n: n(done.removed) })
          : t('jellyfin.disconnected'),
      });
      setAsking(false);
      await onSaved();
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };
  if (!asking)
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className={cx(smallButton, 'text-mid self-start')}
      >
        {t('jellyfin.disconnect')}
      </button>
    );
  const count = imported.data?.imported;
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-white/[0.04] p-3">
      <span className="font-medium">{t('jellyfin.disconnectTitle')}</span>
      <span className="text-muted text-xs leading-relaxed">
        {count === undefined ? t('common.working') : t('jellyfin.disconnectHint', { n: n(count) })}
      </span>
      <span className="flex flex-wrap gap-2">
        {Boolean(count) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void go(true)}
            className={smallButton}
          >
            {t('jellyfin.disconnectRemove', { n: n(count!) })}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void go(false)}
          className={smallButton}
        >
          {t('jellyfin.disconnectKeep')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setAsking(false)}
          className={cx(smallButton, 'text-mid')}
        >
          {t('common.cancel')}
        </button>
      </span>
    </div>
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
  name:
    | 'suwayomi'
    | 'kavita'
    | 'tradoc'
    | 'jellyfin'
    | 'sonarr'
    | 'radarr'
    | 'prowlarr'
    | 'qbittorrent';
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
              <Select
                label={f.label}
                value={value(f)}
                onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
                options={f.options.map((o) => ({ value: o, label: t(`settings.authMode.${o}`) }))}
                size="lg"
                className="w-full rounded-xl"
              />
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
                  await send('/api/settings', 'PATCH', { [f.name]: '' }).catch((e) =>
                    toast({ tone: 'bad', text: errorText(t, e) }),
                  );
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

/** Sonarr/Radarr: the quality profile and folders new works are added with. */
function ArrChoices({
  service,
  settings,
  onSaved,
}: {
  service: 'sonarr' | 'radarr';
  settings: Settings;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const options = useApi<ArrOptions>(`/api/arr/options?service=${service}`);
  const save = async (patch: SettingsPatch) => {
    try {
      await send('/api/settings', 'PATCH', patch);
      await onSaved();
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
    }
  };
  if (options.error) return <ErrorNote error={options.error} />;
  if (!options.data) return <Skeleton className="h-24 rounded-2xl" />;
  const gb = (bytes: number | null) =>
    bytes === null ? '' : ` · ${t('arr.free', { n: Math.round(bytes / 1024 ** 3) })}`;
  const folders = (empty: string) => [
    { value: '', label: empty },
    ...options.data!.folders.map((f) => ({ value: f.path, label: `${f.path}${gb(f.freeSpace)}` })),
  ];
  const profile =
    service === 'sonarr' ? settings.sonarrQualityProfile : settings.radarrQualityProfile;
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.03] p-3 text-sm">
      <Row label={t('arr.profile')}>
        <Select
          label={t('arr.profile')}
          value={String(profile)}
          onChange={(v) => save({ [`${service}QualityProfile`]: Number(v) } as SettingsPatch)}
          options={[
            { value: '0', label: t('arr.first', { name: options.data.profiles[0]?.name ?? '—' }) },
            ...options.data.profiles.map((p) => ({ value: String(p.id), label: p.name })),
          ]}
        />
      </Row>
      <Row label={t(service === 'sonarr' ? 'arr.folderSeries' : 'arr.folderMovies')}>
        <Select
          label={t(service === 'sonarr' ? 'arr.folderSeries' : 'arr.folderMovies')}
          value={service === 'sonarr' ? settings.sonarrRootFolder : settings.radarrRootFolder}
          onChange={(v) => save({ [`${service}RootFolder`]: v } as SettingsPatch)}
          options={folders(t('arr.first', { name: options.data.folders[0]?.path ?? '—' }))}
        />
      </Row>
      {service === 'sonarr' && (
        <Row label={t('arr.folderAnime')} tip={t('arr.folderAnimeTip')}>
          <Select
            label={t('arr.folderAnime')}
            value={settings.sonarrAnimeRootFolder}
            onChange={(v) => save({ sonarrAnimeRootFolder: v })}
            options={folders(t('arr.sameAsSeries'))}
          />
        </Row>
      )}
    </div>
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
      <Row label={t('settings.progressSource')} tip={t('settings.progressSourceTip')}>
        <Select
          label={t('settings.progressSource')}
          value={settings.progressSource ?? 'suwayomi'}
          onChange={async (value) => {
            setError(null);
            try {
              onSaved(
                await send<Settings>('/api/settings', 'PATCH', {
                  progressSource: value as Settings['progressSource'],
                }),
              );
            } catch (err) {
              setError(errorText(t, err));
            }
          }}
          options={[
            { value: 'suwayomi', label: 'Suwayomi' },
            { value: 'kavita', label: 'Kavita' },
          ]}
        />
      </Row>
      <Row label={t('settings.format')} tip={t('settings.formatTip')}>
        <span className="text-mid">CBZ + ComicInfo</span>
      </Row>
    </div>
  );
}

/**
 * Extensions by provider: Suwayomi brings reading sources, Stremio addons bring streams. Both
 * are managed on the Extensions page; this section says what each covers and where it stands.
 */
function ExtensionsSummary({
  settings,
  status,
}: {
  settings: Settings;
  status: ServicesStatus | undefined;
}) {
  const { t, n } = useI18n();
  const sources = useApi<unknown[]>(settings.suwayomiUrl ? '/api/sources' : null);
  const kinds = (list: string[]) => list.map((k) => t(`kind.${k}`)).join(', ');
  const providers = [
    {
      id: 'reading',
      name: 'Suwayomi',
      hint: t('extensions.readingHint', {
        kinds: kinds(KIND_IDS.filter((k) => KIND_DEFS[k].sources)),
      }),
      state: status?.suwayomi.state,
      count: settings.suwayomiUrl
        ? t('extensions.readingCount', { count: n(sources.data?.length ?? 0) })
        : t('extensions.needsSuwayomi'),
    },
    {
      id: 'streaming',
      name: 'Stremio',
      hint: t('extensions.streamingHint', { kinds: kinds(KIND_IDS.filter(isVideoKind)) }),
      state: (settings.videoAddons ?? []).length ? 'ok' : 'unconfigured',
      count: t('extensions.streamingCount', { count: n((settings.videoAddons ?? []).length) }),
    },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {providers.map((p) => (
        <div
          key={p.id}
          className="flex flex-col gap-2.5 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
        >
          <span className="flex items-center gap-2">
            <span className="text-lg font-semibold">{t(`extensions.${p.id}`)}</span>
            <span className="text-muted text-sm">· {p.name}</span>
            <span className="ml-auto">
              <Dot tone={p.state === 'ok' ? 'ok' : p.state === 'error' ? 'bad' : 'idle'} />
            </span>
          </span>
          <p className="text-mid text-sm leading-relaxed">{p.hint}</p>
          <span className="text-muted text-sm">{p.count}</span>
          <Link href={`/sources?provider=${p.id}`} className={cx(smallButton, 'mt-1 self-start')}>
            {t('extensions.manage')} →
          </Link>
        </div>
      ))}
    </div>
  );
}

const KINDS: LibraryKind[] = [
  'MANGA',
  'MANHWA',
  'MANHUA',
  'COMIC',
  'LIGHT_NOVEL',
  'WEB_NOVEL',
  'NOVEL',
  'BOOK',
];

function KavitaTargets({
  admin,
  settings,
  onSaved,
}: {
  admin: boolean | null;
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const { t, n } = useI18n();
  const libraries = useApi<KavitaLibrary[]>(settings.kavitaUrl ? '/api/kavita/libraries' : null);
  const index = useApi<KavitaIndexStatus>(settings.kavitaUrl ? '/api/kavita/status' : null, {
    refreshInterval: 10_000,
  });
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const targets: LibraryTargets = settings.libraryTargets ?? {};
  const relative = useRelativeTime();
  if (!settings.kavitaUrl) return <p className="text-mid text-sm">{t('kavita.needsConnection')}</p>;
  async function save(kind: LibraryKind, value: string) {
    setError(null);
    const next: LibraryTargets = { ...targets };
    if (!value) delete next[kind];
    else if (value === 'none') next[kind] = null;
    else {
      const [libraryId, ...rest] = value.split('|');
      next[kind] = { libraryId: Number(libraryId), folder: rest.join('|') };
    }
    try {
      onSaved(await send<Settings>('/api/settings', 'PATCH', { libraryTargets: next }));
    } catch (e) {
      setError(errorText(t, e));
    }
  }
  const usable = (libraries.data ?? []).some((l) =>
    l.folders.some((f) => f.localPath && f.writable),
  );
  return (
    <div className="flex flex-col gap-5 text-sm">
      <div className="flex flex-wrap items-center gap-3 rounded-[18px] bg-white/[0.045] p-4 md:px-[22px]">
        <Dot
          tone={index.data?.state === 'ok' ? 'ok' : index.data?.state === 'error' ? 'bad' : 'idle'}
        />
        <span>
          {index.data?.state === 'ok'
            ? t('kavita.indexed', {
                count: n(index.data.series),
                when: relative(index.data.syncedAt),
              })
            : index.data?.state === 'error'
              ? t('kavita.indexError')
              : t('kavita.indexPending')}
        </span>
        <button
          type="button"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await send('/api/kavita/sync', 'POST').catch((e) =>
              toast({ tone: 'bad', text: errorText(t, e) }),
            );
            setSyncing(false);
            void index.mutate();
          }}
          className={cx(smallButton, 'md:ml-auto')}
        >
          {syncing ? t('common.working') : t('kavita.sync')}
        </button>
      </div>
      <Row label={t('kavita.autoImport')} tip={t('kavita.autoImportTip')}>
        <input
          type="checkbox"
          checked={settings.autoImportKavita ?? true}
          onChange={async (e) => {
            try {
              onSaved(
                await send<Settings>('/api/settings', 'PATCH', {
                  autoImportKavita: e.target.checked,
                }),
              );
            } catch (err) {
              setError(errorText(t, err));
            }
          }}
          className="accent-fg size-[18px]"
        />
      </Row>
      {admin === false && (
        <Notice tone="bad" title={t('kavita.notAdmin')}>
          {t('kavita.notAdminBody')}
        </Notice>
      )}
      <p className="text-mid leading-relaxed">{t('kavita.targetsHint2')}</p>
      {index.data?.mediaRootOptions && (
        <Row label={t('kavita.mediaRoot')} tip={t('kavita.mediaRootTip')}>
          <Select
            label={t('kavita.mediaRoot')}
            value={settings.mediaRoot ?? ''}
            onChange={async (v) => {
              try {
                onSaved(await send<Settings>('/api/settings', 'PATCH', { mediaRoot: v || null }));
                await Promise.all([index.mutate(), libraries.mutate()]);
              } catch (err) {
                toast({ tone: 'bad', text: errorText(t, err) });
              }
            }}
            size="lg"
            className="w-full rounded-xl md:w-[420px]"
            options={[
              { value: '', label: t('kavita.mediaRootNone') },
              ...index.data.mediaRootOptions.map((o) => ({
                value: o.path,
                disabled: !o.available && o.path !== settings.mediaRoot,
                label:
                  o.usedBy && o.path !== settings.mediaRoot
                    ? `${o.path} — ${t('kavita.mediaRootUsedBy', { name: o.usedBy })}`
                    : o.path,
              })),
            ]}
          />
        </Row>
      )}
      {libraries.error && <ErrorNote error={libraries.error} />}
      {libraries.data && !usable && (
        <p className="text-warn leading-relaxed">{t('kavita.noUsableFolder2')}</p>
      )}
      {KINDS.map((kind) => {
        const current = targets[kind];
        const suggested = (libraries.data ?? []).find(
          (l) => l.suggestedFor?.includes(kind) && l.folders.some((f) => f.localPath && f.writable),
        );
        return (
          <Row key={kind} label={t(`kavita.kind.${kind}`)}>
            <Select
              label={t(`kavita.kind.${kind}`)}
              value={
                current === null ? 'none' : current ? `${current.libraryId}|${current.folder}` : ''
              }
              onChange={(v) => save(kind, v)}
              size="lg"
              className="w-full rounded-xl md:w-[420px]"
              options={[
                {
                  value: '',
                  label: suggested
                    ? t('kavita.suggested', { name: suggested.name })
                    : t('kavita.chooseTarget'),
                },
                { value: 'none', label: t('kavita.noLibrary') },
                ...(libraries.data ?? []).flatMap((lib) =>
                  lib.folders.map((f) => ({
                    value: `${lib.id}|${f.path}`,
                    group: `${lib.name} · ${lib.type}`,
                    disabled: !f.localPath || !f.writable,
                    label: `${f.path}${
                      !f.localPath
                        ? ` — ${t('kavita.notMounted')}`
                        : !f.writable
                          ? ` — ${t('kavita.readOnly')}`
                          : ''
                    }`,
                  })),
                ),
              ]}
            />
          </Row>
        );
      })}
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}

/** The signed-in user's own account: session, language, content filter, Kavita key, password. */
function Account() {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const auth = useApi<AuthState>('/api/auth');
  const me = useApi<MyAccount>('/api/me');
  const [newName, setNewName] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function patchMe(body: MyAccountPatch, ok: string) {
    try {
      await me.mutate(await send<MyAccount>('/api/me', 'PATCH', body), { revalidate: false });
      toast({ tone: 'ok', text: ok });
      return true;
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
      return false;
    }
  }
  async function change(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return toast({ tone: 'bad', text: t('auth.mismatch') });
    setBusy(true);
    try {
      await send('/api/auth/password', 'POST', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast({ tone: 'ok', text: t('auth.passwordChanged') });
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-5 text-sm">
      <Row label={t('auth.signedInAs')}>
        <span className="flex items-center gap-4">
          <strong className="font-semibold">{auth.data?.username ?? '—'}</strong>
          {auth.data?.role && (
            <span className="text-muted text-xs">{t(`users.role.${auth.data.role}`)}</span>
          )}
          <button
            type="button"
            onClick={async () => {
              await send('/api/auth', 'DELETE').catch((e) =>
                toast({ tone: 'bad', text: errorText(t, e) }),
              );
              clearPersistentCache();
              await mutate('/api/auth');
            }}
            className={smallButton}
          >
            {t('settings.signOut')}
          </button>
        </span>
      </Row>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const username = newName.trim();
          if (!username || username === auth.data?.username) return;
          if (await patchMe({ username }, t('users.renamed', { name: username }))) {
            setNewName('');
            await mutate('/api/auth');
          }
        }}
        className="flex flex-col gap-2"
      >
        <span className="text-muted flex items-center gap-2 text-[13px]">
          {t('account.rename')}
          <InfoBubble label={t('account.rename')}>{t('account.renameInfo')}</InfoBubble>
        </span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={auth.data?.username ?? ''}
            minLength={3}
            maxLength={64}
            autoComplete="username"
            aria-label={t('account.rename')}
            className={field}
          />
          <button
            type="submit"
            disabled={!newName.trim() || newName.trim() === auth.data?.username}
            className={cx(smallButton, 'h-11 shrink-0 px-5')}
          >
            {t('users.rename')}
          </button>
        </div>
      </form>
      <Row label={t('settings.language')} tip={t('settings.languageTip')}>
        <LanguageSelect className="h-11 pr-3 pl-4" />
      </Row>
      <Row label={t('settings.adult')} tip={t('settings.adultTip')}>
        <input
          type="checkbox"
          checked={me.data?.adultContent ?? false}
          disabled={!me.data || !me.data.permissions.includes('adult')}
          title={
            me.data && !me.data.permissions.includes('adult')
              ? t('error.PERMISSION_DENIED')
              : undefined
          }
          onChange={async (e) => {
            const value = e.target.checked;
            if (await patchMe({ adultContent: value }, t('account.saved'))) {
              // Drop every cached list (not only mounted ones) so no page shows stale data.
              clearPersistentCache({ resume: true });
              await mutate(
                (key) => typeof key === 'string' && key !== '/api/me' && key !== '/api/auth',
                undefined,
                { revalidate: true },
              );
            }
          }}
          className="accent-fg size-[18px]"
        />
      </Row>
      {!me.data?.adultContent && <HideNsfwSources />}
      <form
        onSubmit={change}
        className="flex flex-col gap-3.5 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
      >
        <span className="font-semibold">{t('auth.changePassword')}</span>
        <div className="grid gap-3.5 md:grid-cols-3">
          {(
            [
              ['current', t('auth.currentPassword'), current, setCurrent, 'current-password'],
              ['next', t('auth.newPassword'), next, setNext, 'new-password'],
              ['confirm', t('auth.confirm'), confirm, setConfirm, 'new-password'],
            ] as const
          ).map(([key, label, value, set, ac]) => (
            <label key={key} className="text-muted flex flex-col gap-1.5 text-[13px]">
              {label}
              <input
                type="password"
                required
                minLength={key === 'current' ? 1 : 10}
                maxLength={200}
                autoComplete={ac}
                value={value}
                onChange={(e) => set(e.target.value)}
                className={field}
              />
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={busy}
          className="bg-fg text-bg h-10 self-start rounded-full px-5 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? t('common.working') : t('auth.changePassword')}
        </button>
      </form>
      {auth.data?.role !== 'member' && (
        <p className="text-muted leading-relaxed">{t('auth.apiTokenHint')}</p>
      )}
    </div>
  );
}

/** Admin: create accounts, rename, change roles, reset passwords, remove users. */
function Users() {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const relative = useRelativeTime();
  const auth = useApi<AuthState>('/api/auth');
  const users = useApi<UserAccount[]>('/api/users');
  const [draft, setDraft] = useState<UserCreate>({ username: '', password: '', role: 'member' });
  const [busy, setBusy] = useState(false);
  async function act(run: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await run();
      await users.mutate();
      toast({ tone: 'ok', text: ok });
      return true;
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const roleOptions = (['member', 'admin'] as UserRole[]).map((r) => ({
    value: r,
    label: t(`users.role.${r}`),
  }));
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-mid leading-relaxed">{t('users.intro')}</p>
      {users.error && <ErrorNote error={users.error} />}
      {!users.data && !users.error && <Skeleton className="h-32 rounded-2xl" />}
      <ul className="flex flex-col">
        {(users.data ?? []).map((u) => {
          const self = u.id === auth.data?.userId;
          return (
            <li
              key={u.id}
              className="border-line flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">
                  {u.username}
                  {self && <span className="text-muted ml-2 font-normal">{t('users.you')}</span>}
                </span>
                <span className="text-muted text-xs">
                  {u.lastSeenAt
                    ? t('users.lastSeen', { when: relative(u.lastSeenAt) })
                    : t('users.neverSeen')}
                  {' · '}
                  {u.kavitaLinked ? t('users.kavitaLinked') : t('users.kavitaNotLinked')}
                </span>
              </span>
              <Select
                label={t('users.roleLabel', { name: u.username })}
                value={u.role}
                onChange={(role) =>
                  act(
                    () =>
                      send('/api/users', 'PATCH', {
                        id: u.id,
                        role: role as UserRole,
                      } satisfies UserPatch),
                    t('users.updated'),
                  )
                }
                options={roleOptions}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const username = window
                    .prompt(t('users.renamePrompt', { name: u.username }), u.username)
                    ?.trim();
                  if (username && username !== u.username)
                    void act(
                      async () => {
                        await send('/api/users', 'PATCH', {
                          id: u.id,
                          username,
                        } satisfies UserPatch);
                        if (self) await mutate('/api/auth');
                      },
                      t('users.renamed', { name: username }),
                    );
                }}
                className={smallButton}
              >
                {t('users.rename')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const password = window.prompt(t('users.resetPrompt', { name: u.username }));
                  if (password)
                    void act(
                      () => send('/api/users', 'PATCH', { id: u.id, password } satisfies UserPatch),
                      t('users.passwordReset'),
                    );
                }}
                className={smallButton}
              >
                {t('users.resetPassword')}
              </button>
              {u.role === 'member' && (
                <fieldset className="flex w-full flex-wrap gap-x-5 gap-y-2 pt-1">
                  <legend className="text-muted mb-1 text-xs">{t('users.permissions')}</legend>
                  {PERMISSIONS.map((p) => (
                    <label key={p} className="flex min-h-9 items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={u.permissions.includes(p)}
                        onChange={(e) =>
                          act(
                            () =>
                              send('/api/users', 'PATCH', {
                                id: u.id,
                                permissions: e.target.checked
                                  ? [...u.permissions, p]
                                  : u.permissions.filter((x) => x !== p),
                              } satisfies UserPatch),
                            t('users.updated'),
                          )
                        }
                        className="size-4 accent-[var(--accent,#9fb6ff)]"
                      />
                      {t(`users.permission.${p}`)}
                    </label>
                  ))}
                </fieldset>
              )}
              {!self && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(t('users.deleteConfirm', { name: u.username })) &&
                    act(() => send('/api/users', 'DELETE', { id: u.id }), t('users.deleted'))
                  }
                  className="text-bad h-9 rounded-full px-3 hover:bg-white/[0.06]"
                >
                  {t('users.delete')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act(() => send('/api/users', 'POST', draft), t('users.created')))
            setDraft({ username: '', password: '', role: 'member' });
        }}
        className="flex flex-col gap-3.5 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
      >
        <span className="font-semibold">{t('users.add')}</span>
        <div className="grid gap-3.5 md:grid-cols-[1fr_1fr_auto]">
          <label className="text-muted flex flex-col gap-1.5 text-[13px]">
            {t('auth.username')}
            <input
              required
              minLength={3}
              maxLength={64}
              autoComplete="off"
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              className={field}
            />
          </label>
          <label className="text-muted flex flex-col gap-1.5 text-[13px]">
            {t('auth.password')}
            <input
              type="password"
              required
              minLength={10}
              maxLength={200}
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
              className={field}
            />
          </label>
          <div className="text-muted flex flex-col gap-1.5 text-[13px]">
            {t('users.role')}
            <Select
              label={t('users.role')}
              value={draft.role}
              onChange={(role) => setDraft((d) => ({ ...d, role: role as UserRole }))}
              options={roleOptions}
              size="lg"
              className="rounded-xl"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="bg-fg text-bg h-10 self-start rounded-full px-5 text-sm font-semibold disabled:opacity-50"
        >
          {t('users.create')}
        </button>
      </form>
    </div>
  );
}

const CATALOGS: {
  id: CatalogProvider;
  url: string;
  fields: { key: string; secret: boolean }[];
}[] = [
  {
    id: 'tmdb',
    url: 'https://www.themoviedb.org/settings/api',
    fields: [{ key: 'tmdbApiKey', secret: true }],
  },
  {
    id: 'googlebooks',
    url: 'https://console.cloud.google.com/apis/credentials',
    fields: [{ key: 'googleBooksApiKey', secret: true }],
  },
  {
    id: 'metron',
    url: 'https://metron.cloud/accounts/tokens/',
    fields: [
      { key: 'metronApiToken', secret: true },
      { key: 'metronUsername', secret: false },
      { key: 'metronPassword', secret: true },
    ],
  },
  {
    id: 'rakuten',
    url: 'https://webservice.rakuten.co.jp/',
    fields: [
      { key: 'rakutenApplicationId', secret: true },
      { key: 'rakutenAccessKey', secret: true },
    ],
  },
  {
    id: 'hardcover',
    url: 'https://hardcover.app/account/api',
    fields: [{ key: 'hardcoverToken', secret: true }],
  },
];

/** Optional catalog providers: each one adds content when its free key is set; nothing changes without. */
function Catalogs({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = settings.catalogs?.canManage ?? false;
  const configured = (k: string) =>
    (settings.secretsConfigured as Record<string, boolean>)[k] ??
    Boolean((settings as unknown as Record<string, unknown>)[k]);
  async function save(p: (typeof CATALOGS)[number], clear = false) {
    if (!canManage) return;
    setBusy(p.id);
    try {
      const patch = Object.fromEntries(
        p.fields
          .map((f) => [f.key, clear ? '' : (draft[f.key] ?? '').trim()] as const)
          .filter(([, v]) => clear || v),
      );
      onSaved(await send<Settings>('/api/settings', 'PATCH', patch));
      setDraft((d) =>
        Object.fromEntries(Object.entries(d).filter(([k]) => !p.fields.some((f) => f.key === k))),
      );
      toast({ tone: 'ok', text: clear ? t('catalogs.removed') : t('catalogs.saved') });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  }
  async function test(id: CatalogProvider) {
    if (!canManage) return;
    setBusy(id);
    try {
      await send('/api/settings/test-provider', 'POST', { provider: id });
      toast({ tone: 'ok', text: t('catalogs.testOk') });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  }
  const renderField = (f: (typeof CATALOGS)[number]['fields'][number]) => (
    <label key={f.key} className="flex flex-col gap-1.5">
      <span className="text-mid text-xs">{t(`catalogs.field.${f.key}`)}</span>
      <input
        type={f.secret ? 'password' : 'text'}
        autoComplete="off"
        value={draft[f.key] ?? (f.secret ? '' : String(settings[f.key as keyof Settings] ?? ''))}
        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
        placeholder={configured(f.key) && f.secret ? '••••••••' : t(`catalogs.field.${f.key}`)}
        className={field}
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-mid leading-relaxed">{t('catalogs.intro')}</p>
      {!canManage && <p className="text-mid">{t('catalogs.managedByAdmin')}</p>}
      {CATALOGS.map((p) => {
        const on = settings.catalogs?.configured[p.id] ?? false;
        const dirty = p.fields.some((f) => (draft[f.key] ?? '').trim());
        return (
          <div
            key={p.id}
            className="flex flex-col gap-3 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{t(`catalogs.${p.id}.name`)}</span>
              <Dot tone={on ? 'ok' : 'idle'} />
              <span className="text-muted">{on ? t('catalogs.on') : t('catalogs.off')}</span>
              {canManage && (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-mid ml-auto underline hover:text-white"
                >
                  {t('catalogs.getKey')} ↗
                </a>
              )}
            </div>
            <p className="text-mid">{t(`catalogs.${p.id}.what`)}</p>
            {canManage && (
              <>
                {p.id === 'googlebooks' && <GoogleBooksHelp />}
                {p.id === 'metron' && <p className="text-mid">{t('catalogs.metron.help')}</p>}
                <div className="grid gap-2 md:grid-cols-2">
                  {p.fields
                    .filter((f) => !['metronUsername', 'metronPassword'].includes(f.key))
                    .map(renderField)}
                </div>
                {p.id === 'metron' && (
                  <details
                    className="text-mid"
                    open={!configured('metronApiToken') && configured('metronPassword')}
                  >
                    <summary className="cursor-pointer">{t('catalogs.metron.legacy')}</summary>
                    <p className="my-2">{t('catalogs.metron.legacyHelp')}</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      {p.fields
                        .filter((f) => ['metronUsername', 'metronPassword'].includes(f.key))
                        .map(renderField)}
                    </div>
                  </details>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null || !dirty}
                    onClick={() => save(p)}
                    className="bg-fg text-bg h-10 rounded-full px-5 font-semibold disabled:opacity-50"
                  >
                    {t('common.save')}
                  </button>
                  {on && (
                    <>
                      <button
                        type="button"
                        disabled={busy !== null || Boolean(dirty)}
                        onClick={() => test(p.id)}
                        className={smallButton}
                      >
                        {busy === p.id ? t('common.working') : t('catalogs.test')}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => save(p, true)}
                        className="text-bad h-9 rounded-full px-3 hover:bg-white/[0.06]"
                      >
                        {t('catalogs.remove')}
                      </button>
                    </>
                  )}
                </div>
                {dirty && <p className="text-muted text-xs">{t('catalogs.saveBeforeTest')}</p>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GoogleBooksHelp() {
  const { t } = useI18n();
  return (
    <details className="text-mid leading-relaxed">
      <summary className="cursor-pointer">{t('catalogs.googlebooks.setup')}</summary>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        <li>{t('catalogs.googlebooks.project')}</li>
        <li>
          <a
            className="underline"
            href="https://console.cloud.google.com/apis/library/books.googleapis.com"
            target="_blank"
            rel="noreferrer"
          >
            {t('catalogs.googlebooks.enable')} ↗
          </a>
        </li>
        <li>{t('catalogs.googlebooks.create')}</li>
        <li>{t('catalogs.googlebooks.restrict')}</li>
        <li>{t('catalogs.googlebooks.paste')}</li>
      </ol>
      <p className="mt-2">{t('catalogs.googlebooks.serverKey')}</p>
    </details>
  );
}

/** While 18+ is off: also leave out extensions marked 18+ by their authors (default on). */
function HideNsfwSources() {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const settings = useApi<Settings>('/api/settings');
  return (
    <Row label={t('settings.hideNsfwSources')} tip={t('settings.hideNsfwSourcesTip')}>
      <input
        type="checkbox"
        checked={settings.data?.hideNsfwSources ?? true}
        disabled={!settings.data}
        onChange={async (e) => {
          try {
            await send('/api/settings', 'PATCH', { hideNsfwSources: e.target.checked });
            clearPersistentCache({ resume: true });
            await mutate((key) => typeof key === 'string' && key.startsWith('/api/'), undefined, {
              revalidate: true,
            });
          } catch (err) {
            toast({ tone: 'bad', text: errorText(t, err) });
          }
        }}
        className="accent-fg size-[18px]"
      />
    </Row>
  );
}

/** Which universes the switcher offers, and whether "Everything" (all together) is one of them. */
function UniverseSettings() {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const settings = useApi<Settings>('/api/settings');
  const data = settings.data;
  const enabled = data?.universes?.length ? data.universes : UNIVERSES;
  const order = completeKindOrder(data?.kindOrder);
  async function save(patch: Partial<Settings>) {
    try {
      await send('/api/settings', 'PATCH', patch);
      await mutate('/api/settings');
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-[18px] bg-white/[0.045] p-4 text-sm md:p-[22px]">
      <p className="text-mid leading-relaxed">{t('universe.settingsHint')}</p>
      <p className="text-mid leading-relaxed">{t('universe.orderHint')}</p>
      <ol
        className="flex flex-col overflow-hidden rounded-2xl bg-white/[0.04]"
        aria-label={t('universe.settingsTitle')}
      >
        {order.map((k, i) => {
          const on = enabled.includes(k);
          const name = t(`kind.${k}`);
          const move = (to: number) => {
            const next = [...order];
            next.splice(i, 1);
            next.splice(to, 0, k);
            void save({ kindOrder: next });
          };
          return (
            <li
              key={k}
              className="border-line flex min-h-[52px] items-center gap-2 border-b px-3 last:border-b-0"
            >
              <span className="text-muted w-6 text-right text-xs tabular-nums">{i + 1}</span>
              <span className={cx('flex-1', !on && 'text-muted')}>{name}</span>
              <button
                type="button"
                disabled={!data || i === 0}
                onClick={() => move(i - 1)}
                aria-label={t('universe.moveUp', { name })}
                className="text-mid flex size-9 items-center justify-center rounded-full hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
              >
                <ChevronUp className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                disabled={!data || i === order.length - 1}
                onClick={() => move(i + 1)}
                aria-label={t('universe.moveDown', { name })}
                className="text-mid flex size-9 items-center justify-center rounded-full hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
              >
                <ChevronDown className="size-4" aria-hidden />
              </button>
              <input
                type="checkbox"
                checked={on}
                disabled={!data || (on && enabled.length === 1)}
                aria-label={t('universe.show', { name })}
                onChange={() =>
                  void save({
                    universes: on ? enabled.filter((x) => x !== k) : [...enabled, k],
                  })
                }
                className="accent-fg ml-1 size-[18px] shrink-0"
              />
            </li>
          );
        })}
      </ol>
      <label className="flex min-h-11 items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span>{t('universe.allOption')}</span>
          <span className="text-muted text-xs">{t('universe.allOptionHint')}</span>
        </span>
        <input
          type="checkbox"
          disabled={!data}
          checked={data?.showAllUniverse ?? true}
          onChange={(e) => void save({ showAllUniverse: e.target.checked })}
          className="accent-fg size-[18px] shrink-0"
        />
      </label>
    </div>
  );
}

/** Live TV: in the menu or not, home countries, the user's playlist and the TV guides. */
function LiveSettings({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const status = useApi<LiveStatus>('/api/live/status');
  const [countries, setCountries] = useState(settings.liveCountries.join(', '));
  const [playlist, setPlaylist] = useState('');
  const [guides, setGuides] = useState(settings.liveGuideUrls.join('\n'));
  const [busy, setBusy] = useState<string | null>(null);
  async function save(name: string, patch: SettingsPatch, ok = t('live.settings.saved')) {
    setBusy(name);
    try {
      onSaved(await send<Settings>('/api/settings', 'PATCH', patch));
      toast({ tone: 'ok', text: ok });
      void status.mutate();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  }
  const s = status.data;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-mid text-sm leading-relaxed">{t('live.settings.intro')}</p>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-white"
          checked={settings.liveEnabled}
          disabled={busy !== null}
          onChange={(e) => void save('enabled', { liveEnabled: e.target.checked })}
        />
        {t('live.settings.enabled')}
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">{t('live.settings.countries')}</span>
        <span className="text-muted text-xs">{t('live.settings.countriesHint')}</span>
        <div className="flex gap-2">
          <input
            className={cx(field, 'h-11 flex-1')}
            value={countries}
            placeholder="FR, BE, CH"
            onChange={(e) => setCountries(e.target.value)}
          />
          <button
            type="button"
            className={smallButton}
            disabled={busy !== null}
            onClick={() =>
              void save('countries', {
                liveCountries: [
                  ...new Set(
                    countries
                      .toUpperCase()
                      .split(/[\s,;]+/)
                      .filter((c) => /^[A-Z]{2}$/.test(c)),
                  ),
                ].slice(0, 20),
              })
            }
          >
            {t('common.save')}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">{t('live.settings.playlist')}</span>
        <span className="text-muted text-xs">{t('live.settings.playlistHint')}</span>
        <div className="flex flex-wrap gap-2">
          <input
            type="password"
            autoComplete="off"
            className={cx(field, 'h-11 min-w-[240px] flex-1')}
            value={playlist}
            placeholder={
              settings.secretsConfigured.livePlaylistUrl
                ? t('live.settings.playlistSet')
                : 'https://…/playlist.m3u'
            }
            onChange={(e) => setPlaylist(e.target.value)}
          />
          <button
            type="button"
            className={smallButton}
            disabled={busy !== null || !playlist.trim()}
            onClick={() =>
              void save('playlist', { livePlaylistUrl: playlist.trim() }).then(() =>
                setPlaylist(''),
              )
            }
          >
            {t('common.save')}
          </button>
          {settings.secretsConfigured.livePlaylistUrl && (
            <button
              type="button"
              className={smallButton}
              disabled={busy !== null}
              onClick={() => void save('playlist', { livePlaylistUrl: '' })}
            >
              {t('live.settings.remove')}
            </button>
          )}
        </div>
        {s?.playlist.configured && (
          <span className="text-muted text-xs">
            {s.playlist.error
              ? t('live.settings.failed', { code: s.playlist.error })
              : t('live.settings.playlistStatus', {
                  entries: n(s.playlist.entries),
                  matched: n(s.playlist.matched),
                })}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">{t('live.settings.guides')}</span>
        <span className="text-muted text-xs">{t('live.settings.guidesHint')}</span>
        <textarea
          className={cx(field, 'min-h-[88px] py-2.5 font-mono text-xs')}
          value={guides}
          onChange={(e) => setGuides(e.target.value)}
        />
        <button
          type="button"
          className={cx(smallButton, 'self-start')}
          disabled={busy !== null}
          onClick={() =>
            void save('guides', {
              liveGuideUrls: guides
                .split(/\s+/)
                .map((g) => g.trim())
                .filter((g) => /^https?:\/\//i.test(g))
                .slice(0, 10),
            })
          }
        >
          {t('common.save')}
        </button>
        {s?.guides.map((g) => (
          <span key={g.url} className="text-muted truncate text-xs">
            {g.url === 'playlist' ? t('live.settings.playlistGuide') : g.url} ·{' '}
            {g.error
              ? t('live.settings.failed', { code: g.error })
              : g.at
                ? relative(g.at)
                : t('live.settings.never')}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-mid text-sm">
          {s
            ? t('live.settings.status', {
                channels: n(s.channels),
                playable: n(s.playable),
                programmes: n(s.programmes),
              })
            : '…'}
          {s?.indexAt ? ` · ${relative(s.indexAt)}` : ''}
        </span>
        <button
          type="button"
          className={smallButton}
          disabled={busy !== null}
          onClick={async () => {
            setBusy('refresh');
            try {
              await status.mutate(await send<LiveStatus>('/api/live/refresh', 'POST', {}), {
                revalidate: false,
              });
              toast({ tone: 'ok', text: t('live.settings.refreshed') });
            } catch (e) {
              toast({ tone: 'bad', text: errorText(t, e) });
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'refresh' ? t('common.working') : t('live.settings.refresh')}
        </button>
      </div>
    </div>
  );
}
