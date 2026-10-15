'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Extension, PublicSettings, SourceInfo, SourcePreferences } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import {
  Dot,
  Empty,
  ErrorNote,
  PageTitle,
  Skeleton,
  Tabs,
  cx,
  errorText,
  field,
  smallButton,
} from '@/components/ui';

type View = 'sources' | 'updates' | 'catalog' | 'repos';

export default function SourcesPage() {
  const { t } = useI18n();
  const [view, setView] = useState<View>('sources');
  const sources = useApi<SourceInfo[]>('/api/sources');
  const prefs = useApi<SourcePreferences>('/api/sources/preferences');
  const extensions = useApi<Extension[]>('/api/extensions');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const engine = useSuwayomi();
  const updates = (extensions.data ?? []).filter((e) => e.isInstalled && e.hasUpdate);
  async function act(id: string, body: object) {
    setBusy(id);
    setError(null);
    try {
      await send('/api/extensions/action', 'POST', body);
      await Promise.all([extensions.mutate(), sources.mutate()]);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Page className="pb-16">
      <PageTitle
        title={t('sources.title')}
        aside={sources.data ? t('sources.aside', { count: sources.data.length }) : undefined}
      />
      {updates.length > 0 && (
        <div className="flex flex-col gap-3 rounded-[18px] bg-[#fbbf24]/[0.08] p-4 md:flex-row md:items-center md:gap-[18px] md:px-[22px] md:py-[18px]">
          <span className="flex items-center gap-3 font-serif text-[20px] md:text-[22px]">
            <Dot tone="warn" className="size-[9px]" />
            {t('sources.updatesBanner', { count: updates.length })}
          </span>
          <span className="text-mid text-[13px]">{t('sources.updatesHint')}</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act('all', { action: 'update_all' })}
            className="bg-fg text-bg h-[42px] rounded-full px-[22px] text-sm font-semibold md:ml-auto"
          >
            {busy === 'all' ? t('common.working') : t('sources.updateAll')}
          </button>
        </div>
      )}
      <Tabs
        value={view}
        onChange={setView}
        label={t('sources.view')}
        items={[
          { id: 'sources', label: t('sources.tab.sources'), count: sources.data?.length },
          { id: 'updates', label: t('sources.tab.updates'), count: updates.length },
          { id: 'catalog', label: t('sources.tab.catalog'), count: extensions.data?.length },
          { id: 'repos', label: t('sources.tab.repos') },
        ]}
      />
      {error && (
        <p role="alert" className="text-bad text-sm">
          {error}
        </p>
      )}
      {engine.state && engine.state !== 'ok' && view !== 'repos' ? (
        <SuwayomiNotice />
      ) : (
        <>
          {view === 'sources' && (
            <MySources
              sources={sources}
              prefs={prefs}
              extensions={extensions.data ?? []}
              onOpenRepos={() => setView('repos')}
            />
          )}
          {view === 'updates' &&
            (updates.length === 0 ? (
              <Empty title={t('sources.noUpdates')} />
            ) : (
              <ExtensionList items={updates} busy={busy} onAct={act} />
            ))}
          {view === 'catalog' && (
            <ExtensionCatalog extensions={extensions} prefs={prefs.data} busy={busy} onAct={act} />
          )}
        </>
      )}
      {view === 'repos' && (
        <Repos
          onRefresh={() => act('refresh', { action: 'refresh' })}
          refreshing={busy === 'refresh'}
        />
      )}
    </Page>
  );
}

function MySources({
  sources,
  prefs,
  extensions,
  onOpenRepos,
}: {
  sources: ReturnType<typeof useApi<SourceInfo[]>>;
  prefs: ReturnType<typeof useApi<SourcePreferences>>;
  extensions: Extension[];
  onOpenRepos: () => void;
}) {
  const { t, n } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const list = sources.data ?? [];
  const ordered = [...list].sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  async function save(next: Partial<SourcePreferences>) {
    setError(null);
    try {
      const saved = await send<SourcePreferences>('/api/sources/preferences', 'PUT', {
        enabledSourceIds: next.enabledSourceIds ?? prefs.data?.enabledSourceIds ?? [],
        languages: next.languages ?? prefs.data?.languages ?? ['fr'],
      });
      await prefs.mutate(saved, { revalidate: false });
      await sources.mutate();
    } catch (e) {
      setError(errorText(t, e));
    }
  }
  const enabledIds = ordered.filter((s) => s.enabled).map((s) => s.id);
  const toggle = (s: SourceInfo) =>
    save({
      enabledSourceIds: s.enabled ? enabledIds.filter((id) => id !== s.id) : [...enabledIds, s.id],
    });
  const move = (s: SourceInfo, d: -1 | 1) => {
    const ids = [...enabledIds];
    const i = ids.indexOf(s.id);
    if (i < 0 || i + d < 0 || i + d >= ids.length) return;
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    void save({ enabledSourceIds: ids });
  };
  const languages = prefs.data?.languages ?? ['fr'];
  const available = [...new Set([...languages, ...extensions.map((e) => e.lang)])]
    .filter((l) => l && l !== 'all')
    .sort();
  if (sources.error) return <ErrorNote error={sources.error} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted mr-1">{t('sources.languages')}</span>
        {available.slice(0, 18).map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={languages.includes(l)}
            onClick={() => {
              const next = languages.includes(l)
                ? languages.filter((x) => x !== l)
                : [...languages, l];
              if (next.length) void save({ languages: next });
            }}
            className={cx(
              'h-8 rounded-full px-3 uppercase',
              languages.includes(l) ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.07]',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-bad text-sm">
          {error}
        </p>
      )}
      {!sources.data && <Skeleton className="h-64 rounded-2xl" />}
      {sources.data && list.length === 0 && (
        <Empty
          title={t('sources.noSourcesInstalled')}
          action={
            <button type="button" onClick={onOpenRepos} className={smallButton}>
              {t('sources.tab.repos')} →
            </button>
          }
        >
          {t('sources.noSourcesBody')}
        </Empty>
      )}
      {list.length > 0 && (
        <div className="flex flex-col">
          <div className="text-muted hidden grid-cols-[44px_minmax(0,1fr)_170px_200px_150px] px-1 pb-2 text-xs tracking-[0.12em] uppercase md:grid">
            <span />
            <span>{t('sources.col.source')}</span>
            <span>{t('sources.col.health')}</span>
            <span>{t('sources.col.global')}</span>
            <span className="text-right">{t('sources.col.actions')}</span>
          </div>
          {ordered.map((s) => {
            const ext = extensions.find((e) => e.id === s.extensionId);
            const tone =
              s.health.state === 'ok'
                ? 'ok'
                : s.health.state === 'slow'
                  ? 'warn'
                  : s.health.state === 'error'
                    ? 'bad'
                    : 'idle';
            return (
              <div
                key={s.id}
                className="border-line grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b py-3 text-sm md:grid-cols-[44px_minmax(0,1fr)_170px_200px_150px] md:gap-y-0 md:px-1"
              >
                {s.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- proxied extension icon
                  <img src={s.iconUrl} alt="" className="size-[34px] rounded-[9px]" />
                ) : (
                  <span className="bg-hover font-display flex size-[34px] items-center justify-center rounded-[9px] font-extrabold">
                    {s.name[0]}
                  </span>
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/source/${s.id}`}
                    className="truncate text-[15px] font-semibold hover:underline"
                  >
                    {s.name}
                  </Link>
                  <span className="text-muted truncate text-xs">
                    {s.lang.toUpperCase()}
                    {ext ? ` · v${ext.versionName}` : ''}
                    {ext?.hasUpdate ? ` · ${t('sources.updateAvailable')}` : ''}
                  </span>
                </span>
                <span className="text-mid col-start-2 row-start-2 flex items-center gap-2 text-xs md:col-start-auto md:row-start-auto md:text-sm">
                  <Dot tone={tone} />
                  {s.health.state === 'unknown'
                    ? t('sources.health.unknown')
                    : s.health.state === 'error'
                      ? t(`error.${s.health.error}`) === `error.${s.health.error}`
                        ? t('sources.health.error')
                        : t(`error.${s.health.error}`)
                      : t('sources.health.latency', {
                          s: n((s.health.latencyMs ?? 0) / 1000, { maximumFractionDigits: 1 }),
                        })}
                </span>
                <label className="text-mid col-start-2 row-start-3 flex items-center gap-2.5 text-xs md:col-start-auto md:row-start-auto md:text-sm">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => toggle(s)}
                    className="accent-fg size-[17px]"
                  />
                  {s.enabled
                    ? t('sources.included', { n: (s.priority ?? 0) + 1 })
                    : t('sources.excluded')}
                </label>
                <span className="col-start-3 row-span-3 row-start-1 flex items-center justify-end gap-0.5 md:col-start-auto md:row-span-1 md:row-start-auto">
                  {s.enabled && (
                    <>
                      <button
                        type="button"
                        aria-label={t('sources.up')}
                        onClick={() => move(s, -1)}
                        className="text-mid hidden size-8 items-center justify-center rounded-full hover:bg-white/[0.08] md:flex"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={t('sources.down')}
                        onClick={() => move(s, 1)}
                        className="text-mid hidden size-8 items-center justify-center rounded-full hover:bg-white/[0.08] md:flex"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <Link href={`/source/${s.id}`} className={smallButton}>
                    {t('search.explore')}
                  </Link>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExtensionList({
  items,
  busy,
  onAct,
}: {
  items: Extension[];
  busy: string | null;
  onAct: (id: string, body: object) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col">
      {items.map((e) => (
        <li key={e.id} className="border-line flex items-center gap-3 border-b py-3 text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- proxied extension icon */}
          <img src={e.iconUrl} alt="" className="size-[34px] rounded-[9px]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-semibold">{e.name}</span>
            <span className="text-muted text-xs">
              {e.lang.toUpperCase()} · v{e.versionName}
              {e.hasUpdate ? ` · ${t('sources.updateAvailable')}` : ''}
            </span>
          </span>
          {e.isInstalled ? (
            <>
              {e.hasUpdate && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onAct(e.id, { action: 'update', id: e.id })}
                  className="bg-fg text-bg h-9 rounded-full px-4 text-[13px] font-semibold"
                >
                  {busy === e.id ? t('common.working') : t('sources.update')}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  window.confirm(t('sources.uninstallConfirm', { name: e.name })) &&
                  onAct(e.id, { action: 'uninstall', id: e.id })
                }
                className="text-muted h-9 rounded-full px-3 text-[13px] hover:text-white"
              >
                {t('sources.uninstall')}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onAct(e.id, { action: 'install', id: e.id })}
              className={smallButton}
            >
              {busy === e.id ? t('common.working') : t('sources.install')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ExtensionCatalog({
  extensions,
  prefs,
  busy,
  onAct,
}: {
  extensions: ReturnType<typeof useApi<Extension[]>>;
  prefs: SourcePreferences | undefined;
  busy: string | null;
  onAct: (id: string, body: object) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(true);
  const languages = prefs?.languages ?? ['fr'];
  if (extensions.error) return <ErrorNote error={extensions.error} />;
  if (!extensions.data) return <Skeleton className="h-64 rounded-2xl" />;
  if (extensions.data.length === 0)
    return <Empty title={t('sources.noExtensions')}>{t('sources.noExtensionsBody')}</Empty>;
  const items = extensions.data
    .filter((e) => !mine || languages.includes(e.lang) || e.lang === 'all')
    .filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.isInstalled) - Number(a.isInstalled) || a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('sources.filterExtensions')}
          aria-label={t('sources.filterExtensions')}
          className={cx(field, 'max-w-sm rounded-full')}
        />
        <label className="text-mid flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
            className="accent-fg size-4"
          />
          {t('sources.myLanguages')}
        </label>
      </div>
      <ExtensionList items={items.slice(0, 200)} busy={busy} onAct={onAct} />
    </div>
  );
}

function Repos({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  const { t } = useI18n();
  const settings = useApi<PublicSettings>('/api/settings');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const repos = settings.data?.extensionRepos ?? [];
  async function save(next: string[]) {
    setError(null);
    try {
      await settings.mutate(
        await send<PublicSettings>('/api/settings', 'PATCH', { extensionRepos: next }),
        { revalidate: false },
      );
      setUrl('');
    } catch (e) {
      setError(errorText(t, e));
    }
  }
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <p className="text-mid text-sm leading-relaxed">{t('sources.reposHint')}</p>
      <ul className="flex flex-col">
        {repos.map((r) => (
          <li key={r} className="border-line flex items-center gap-3 border-b py-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{r}</span>
            <button
              type="button"
              onClick={() => save(repos.filter((x) => x !== r))}
              className="text-muted text-[13px] hover:text-white"
            >
              {t('sources.removeRepo')}
            </button>
          </li>
        ))}
        {repos.length === 0 && settings.data && (
          <li className="text-muted font-serif text-lg italic">{t('sources.noRepos')}</li>
        )}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void save([...repos, url.trim()]);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/index.min.json"
          aria-label={t('sources.repoUrl')}
          className={field}
        />
        <button type="submit" className={cx(smallButton, 'h-11 shrink-0 px-5')}>
          {t('sources.addRepo')}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-bad text-sm">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
        className={cx(smallButton, 'self-start')}
      >
        {refreshing ? t('common.working') : t('sources.refreshRepos')}
      </button>
    </div>
  );
}
