'use client';
import { Select } from '@/components/select';
import { clearPersistentCache } from '@/lib/client/cache';
import Link from 'next/link';
import { InfoBubble, Notice, toast } from '@/components/notify';
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import type {
  AuthState,
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
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { LanguageSelect, Page } from '@/components/shell';
import { useRelativeTime } from '@/components/time';
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

const SECTIONS = [
  'account',
  'users',
  'connections',
  'kavita',
  'downloads',
  'sources',
  'modules',
] as const;
/** Members only manage their own account; everything else is server administration. */
const MEMBER_SECTIONS: readonly SectionId[] = ['account'];
type Settings = PublicSettings & { updateIntervalMinutes?: number };

type SectionId = (typeof SECTIONS)[number];
const subscribeHash = (l: () => void) => {
  window.addEventListener('hashchange', l);
  return () => window.removeEventListener('hashchange', l);
};

export default function SettingsPage() {
  const { t } = useI18n();
  // Phones show the list of sections first, then one section with a back button; a link such as
  // /settings#display opens that section directly. Desktop keeps everything on one page.
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash.slice(1),
    () => '',
  );
  const [picked, setPicked] = useState<SectionId | null | undefined>(undefined);
  const auth = useApi<AuthState>('/api/auth');
  const visible: readonly SectionId[] = auth.data?.role === 'member' ? MEMBER_SECTIONS : SECTIONS;
  const open: SectionId | null =
    picked !== undefined
      ? picked
      : (visible as readonly string[]).includes(hash)
        ? (hash as SectionId)
        : null;
  const settings = useApi<Settings>('/api/settings');
  const status = useApi<ServicesStatus>('/api/status');
  return (
    <Page className="pb-20 md:grid md:grid-cols-[260px_minmax(0,1fr)] md:gap-20">
      <nav
        aria-label={t('settings.sections')}
        className={cx(
          'flex-col md:sticky md:top-28 md:flex md:self-start',
          open ? 'hidden' : 'flex',
        )}
      >
        <h1 className="font-display mb-4 text-[40px] leading-none font-extrabold tracking-[-0.04em] md:mb-6 md:text-[52px]">
          {t('nav.settings')}
        </h1>
        <div className="flex flex-col">
          {visible.map((s, i) => (
            <a
              key={s}
              href={`#${s}`}
              aria-current={(open ?? visible[0]) === s ? 'page' : undefined}
              onClick={(e) => {
                // One section at a time on every screen; the hash keeps it linkable.
                e.preventDefault();
                setPicked(s);
                history.replaceState(null, '', `#${s}`);
                window.scrollTo(0, 0);
              }}
              className={cx(
                'border-line flex min-h-14 items-center gap-3.5 border-b hover:text-white md:min-h-0 md:items-baseline md:py-2.5',
                (open ?? visible[0]) === s ? 'md:font-semibold md:text-white' : 'text-mid',
              )}
            >
              <span className="text-muted w-[30px] font-serif text-lg">{roman(i + 1)}</span>
              <span className="flex-1 text-[17px] md:text-[15px]">
                {t(`settings.section.${s}`)}
              </span>
              <span aria-hidden className="text-muted md:hidden">
                ›
              </span>
            </a>
          ))}
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
        {visible.includes('users') && (
          <Section open={open} visible={visible} id="users">
            <Users />
          </Section>
        )}
        {visible.includes('connections') &&
          (settings.error ? (
            <ErrorNote error={settings.error} />
          ) : !settings.data ? (
            <Skeleton className="h-96 rounded-2xl" />
          ) : (
            <>
              <Section open={open} visible={visible} id="connections">
                <Connections
                  settings={settings.data}
                  status={status.data}
                  onSaved={() => Promise.all([settings.mutate(), status.mutate()])}
                />
              </Section>
              <Section open={open} visible={visible} id="kavita">
                <KavitaTargets
                  admin={status.data?.kavita.admin ?? null}
                  settings={settings.data}
                  onSaved={(s) => settings.mutate(s, { revalidate: false })}
                />
              </Section>
              <Section open={open} visible={visible} id="downloads">
                <Downloads
                  settings={settings.data}
                  onSaved={(s) => settings.mutate(s, { revalidate: false })}
                />
              </Section>
              <Section open={open} visible={visible} id="sources">
                <p className="text-mid text-sm leading-relaxed">{t('settings.sourcesBody')}</p>
                <Link href="/sources" className={cx(smallButton, 'self-start')}>
                  {t('settings.manageSources')} →
                </Link>
              </Section>
              <Section open={open} visible={visible} id="modules">
                <Modules />
              </Section>
            </>
          ))}
      </div>
    </Page>
  );
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
  const index = visible.indexOf(id) + 1;
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
        { name: 'kavitaLibraryPath', label: t('settings.libraryPathOptional') },
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

const KINDS: LibraryKind[] = ['MANGA', 'MANHWA', 'MANHUA', 'NOVEL'];

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
            await send('/api/kavita/sync', 'POST').catch(() => undefined);
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
  const [kavitaKey, setKavitaKey] = useState('');
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
              await send('/api/auth', 'DELETE').catch(() => undefined);
              clearPersistentCache();
              await mutate('/api/auth');
            }}
            className={smallButton}
          >
            {t('settings.signOut')}
          </button>
        </span>
      </Row>
      <Row label={t('settings.language')} tip={t('settings.languageTip')}>
        <LanguageSelect className="h-11 pr-3 pl-4" />
      </Row>
      <Row label={t('settings.adult')} tip={t('settings.adultTip')}>
        <input
          type="checkbox"
          checked={me.data?.adultContent ?? false}
          disabled={!me.data}
          onChange={async (e) => {
            const value = e.target.checked;
            if (await patchMe({ adultContent: value }, t('account.saved'))) {
              // Drop every cached list (not only mounted ones) so no page shows stale data.
              clearPersistentCache();
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
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await patchMe({ kavitaApiKey: kavitaKey.trim() }, t('account.kavitaSaved')))
            setKavitaKey('');
        }}
        className="flex flex-col gap-3 rounded-[18px] bg-white/[0.045] p-4 md:p-[22px]"
      >
        <span className="flex items-center gap-2 font-semibold">
          {t('account.kavitaKey')}
          <InfoBubble label={t('account.kavitaKey')}>{t('account.kavitaKeyInfo')}</InfoBubble>
        </span>
        <p className="text-mid">
          {me.data?.kavitaLinked ? t('account.kavitaLinked') : t('account.kavitaNotLinked')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            autoComplete="off"
            value={kavitaKey}
            onChange={(e) => setKavitaKey(e.target.value)}
            placeholder={t('account.kavitaKeyPlaceholder')}
            aria-label={t('account.kavitaKey')}
            className={field}
          />
          <button
            type="submit"
            disabled={!kavitaKey.trim()}
            className="bg-fg text-bg h-11 shrink-0 rounded-full px-5 font-semibold disabled:opacity-50"
          >
            {t('common.save')}
          </button>
          {me.data?.kavitaLinked && (
            <button
              type="button"
              onClick={() => patchMe({ kavitaApiKey: null }, t('account.kavitaRemoved'))}
              className={cx(smallButton, 'h-11 shrink-0')}
            >
              {t('account.kavitaRemove')}
            </button>
          )}
        </div>
      </form>
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

/** Admin: create accounts, change roles, reset passwords, remove users. */
function Users() {
  const { t } = useI18n();
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
                    () => send('/api/users', 'PATCH', { id: u.id, role: role as UserRole } satisfies UserPatch),
                    t('users.updated'),
                  )
                }
                options={roleOptions}
              />
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
