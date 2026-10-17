'use client';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import type { AuthState, DownloadBatch, Extension } from '@/types/shared';
import { PRODUCT_NAME } from '@/lib/client/brand';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { UI_LANGUAGES, type UiLanguage } from '@/i18n/messages';
import { UNAUTHORIZED_EVENT, send, useApi, batchesInterval } from '@/lib/client/api';
import { cx, errorText, field, primaryButton, Skeleton } from './ui';
import { OPEN_SEARCH_EVENT, QuickSearch } from './quick-search';
import { ActivityPill } from './activity';
import { Toaster } from './notify';
import { Select } from './select';
import { persistentCache } from '@/lib/client/cache';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <SWRConfig value={{ revalidateOnFocus: false, provider: persistentCache }}>
        <AuthGate>{children}</AuthGate>
      </SWRConfig>
    </I18nProvider>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { data, error, isLoading, mutate } = useApi<AuthState>('/api/auth');
  const { mutate: mutateAll } = useSWRConfig();
  useEffect(() => {
    const onUnauthorized = () => void mutate(undefined, { revalidate: true });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [mutate]);
  // A neutral frame while the session is checked: no private data, but no blank page either.
  if (isLoading)
    return (
      <div className="min-h-dvh" aria-busy="true">
        <div className="flex h-14 items-center gap-2.5 px-4 text-white md:h-20 md:px-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))]">
          <Logo />
          <span className="font-display text-[19px] font-extrabold tracking-[-0.03em] md:text-[21px]">
            {PRODUCT_NAME}
          </span>
        </div>
        <div className="mx-auto flex max-w-[1760px] flex-col gap-6 px-4 pt-10 md:px-10 md:pt-20">
          <Skeleton className="h-12 w-64 rounded-xl" />
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 md:gap-6 xl:grid-cols-8">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-[2/3] rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  if (error || !data?.authenticated)
    return (
      <AuthScreen
        mode={data?.setupRequired ? 'setup' : 'login'}
        onDone={async () => {
          await mutateAll(() => true, undefined, { revalidate: true });
        }}
      />
    );
  return (
    <>
      <Header />
      <Shortcuts />
      <div className="pb-24 md:pb-0">{children}</div>
      <TabBar />
      <Toaster />
    </>
  );
}

function Logo({ size = 24 }: { size?: number }) {
  // Bunko mark: a paperback with its obi band and a vertical title line.
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <rect x="15" y="7" width="34" height="50" rx="3.5" stroke="currentColor" strokeWidth="4" />
      <path d="M41 14v17" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <rect x="15" y="39" width="34" height="11" fill="currentColor" />
    </svg>
  );
}

export function LanguageSelect({ className }: { className?: string }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <Select
      label={t('settings.language')}
      value={language}
      onChange={(v) => setLanguage(v as UiLanguage)}
      options={UI_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
      className={className}
    />
  );
}

/** First start creates the administrator account; afterwards the same screen signs in. */
function AuthScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = mode === 'setup';
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) return setError(t('auth.mismatch'));
    setBusy(true);
    try {
      await send(setup ? '/api/auth/setup' : '/api/auth', 'POST', {
        username: username.trim(),
        password,
      });
      await onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div
        aria-hidden
        // A radial gradient looks like a blurred glow without a costly blur filter.
        className="absolute -top-40 -left-40 size-[620px] bg-[radial-gradient(closest-side,rgba(122,162,255,0.09),transparent)]"
      />
      <div className="absolute top-4 right-4">
        <LanguageSelect />
      </div>
      <form onSubmit={submit} className="relative flex w-full max-w-md flex-col gap-5">
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <span className="font-display text-[44px] font-extrabold tracking-[-0.04em]">
            {PRODUCT_NAME}
          </span>
        </div>
        <p className="text-soft font-serif text-[24px] leading-snug italic">
          {setup ? t('auth.setupTagline') : t('login.tagline')}
        </p>
        {setup && <p className="text-mid text-sm leading-relaxed">{t('auth.setupHint')}</p>}
        <label className="text-muted flex flex-col gap-2 text-sm">
          {t('auth.username')}
          <input
            autoComplete="username"
            required
            minLength={setup ? 3 : 1}
            maxLength={40}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={cx(field, 'h-12 text-base')}
          />
        </label>
        <label className="text-muted flex flex-col gap-2 text-sm">
          {t('auth.password')}
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            required
            minLength={setup ? 10 : 1}
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cx(field, 'h-12 text-base')}
          />
          {setup && <span className="text-faint text-xs">{t('auth.passwordRule')}</span>}
        </label>
        {setup && (
          <label className="text-muted flex flex-col gap-2 text-sm">
            {t('auth.confirm')}
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={cx(field, 'h-12 text-base')}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-bad text-sm">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className={primaryButton}
        >
          {busy ? t('login.signingIn') : setup ? t('auth.create') : t('login.signIn')}
        </button>
        {!setup && <p className="text-muted text-[13px] leading-relaxed">{t('auth.forgotHint')}</p>}
      </form>
    </main>
  );
}

const NAV = [
  { href: '/', key: 'nav.home' },
  { href: '/catalog', key: 'nav.catalog' },
  { href: '/library', key: 'nav.library' },
  { href: '/planning', key: 'nav.planning' },
];

function useActivity() {
  const batches = useApi<DownloadBatch[]>('/api/downloads/batches', {
    refreshInterval: batchesInterval,
  });
  const extensions = useApi<Extension[]>('/api/extensions', { refreshInterval: 30 * 60_000 });
  return {
    active: (batches.data ?? []).filter((b) => b.state !== 'completed' && b.state !== 'error')
      .length,
    failed: (batches.data ?? []).filter((b) => b.state === 'error').length,
    updates: (extensions.data ?? []).filter((e) => e.isInstalled && e.hasUpdate).length,
  };
}

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function Header() {
  const { t } = useI18n();
  const pathname = usePathname();
  const activity = useActivity();
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header
      className={cx(
        // Content aligns with the 1760px page column on wide screens; no hard edge under the bar.
        'fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-6 px-4 transition-[background-color,backdrop-filter] duration-300 md:h-20 md:gap-11 md:px-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))]',
        solid ? 'bg-bg/90 backdrop-blur-md' : 'bg-gradient-to-b from-black/45 to-transparent',
      )}
    >
      <Link href="/" className="flex items-center gap-2.5 text-white">
        <Logo />
        <span className="font-display text-[19px] font-extrabold tracking-[-0.03em] md:text-[21px]">
          {PRODUCT_NAME}
        </span>
      </Link>
      <nav aria-label={t('nav.label')} className="hidden gap-7 text-[15px] md:flex">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(pathname, n.href) ? 'page' : undefined}
            className={
              isActive(pathname, n.href) ? 'font-semibold text-white' : 'text-mid hover:text-white'
            }
          >
            {t(n.key)}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <ActivityPill />
        <QuickSearch variant="inline" />
        <button
          type="button"
          aria-label={t('nav.search')}
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          className="relative flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.08] lg:hidden"
        >
          <SearchIcon size={20} />
        </button>
        <IconLink
          href="/downloads"
          label={
            activity.active
              ? t('nav.downloadsActive', { count: activity.active })
              : t('nav.downloads')
          }
          className="hidden md:flex"
        >
          <DownloadIcon />
          {activity.active > 0 && (
            <span className="bg-fg text-bg absolute top-1.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
              {activity.active}
            </span>
          )}
        </IconLink>
        <IconLink
          href="/sources"
          label={
            activity.updates
              ? t('nav.sourcesUpdates', { count: activity.updates })
              : t('nav.sources')
          }
          className="hidden md:flex"
        >
          <PuzzleIcon />
          {activity.updates > 0 && (
            <span className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
          )}
        </IconLink>
        <IconLink href="/settings" label={t('nav.settings')} className="hidden md:flex">
          <SlidersIcon />
        </IconLink>
        <MobileMenu />
      </div>
    </header>
  );
}

/** Phones: one menu for everything that does not fit the tab bar (settings, downloads, sources…). */
function MobileMenu() {
  const { t } = useI18n();
  const pathname = usePathname();
  const auth = useApi<AuthState>('/api/auth');
  const [open, setOpen] = useState(false);
  // Navigating closes the menu.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  const links = [
    { href: '/downloads', label: t('nav.downloads') },
    { href: '/sources', label: t('nav.sources') },
    { href: '/settings', label: t('nav.settings') },
  ];
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label={t('nav.menu')}
        className="flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.08] md:hidden"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-y-0 right-0 z-50 flex w-[min(320px,85vw)] flex-col border-l p-5 pt-[max(env(safe-area-inset-top),20px)] outline-none">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-display text-2xl font-extrabold tracking-[-0.03em]">
              {PRODUCT_NAME}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t('common.close')}
              className="text-mid flex size-11 items-center justify-center rounded-full hover:bg-white/[0.08]"
            >
              ✕
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-muted mt-1 text-sm">
            {auth.data?.username ?? ''}
          </Dialog.Description>
          <nav className="mt-6 flex flex-col" aria-label={t('nav.menu')}>
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={isActive(pathname, l.href) ? 'page' : undefined}
                className={cx(
                  'border-line flex min-h-14 items-center justify-between border-b text-[17px]',
                  isActive(pathname, l.href) ? 'font-semibold text-white' : 'text-mid',
                )}
              >
                {l.label}
                <span aria-hidden className="text-muted">
                  ›
                </span>
              </Link>
            ))}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IconLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={cx(
        'relative flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.08]',
        className,
      )}
    >
      {children}
    </Link>
  );
}

const TABS = [
  { href: '/', key: 'nav.home', icon: 'M3 11 12 4l9 7v9h-6v-6H9v6H3v-9Z' },
  {
    href: '/catalog',
    key: 'nav.catalog',
    icon: 'M4 4h4v16H4zM10 4h4v16h-4zM16.5 5l3.8 1-3.9 14.5-3.8-1L16.5 5Z',
  },
  {
    href: '/planning',
    key: 'nav.planning',
    icon: 'M4 6h16v14H4zM4 10h16M8 3v4m8-4v4',
  },
  {
    href: '/library',
    key: 'nav.libraryShort',
    icon: 'M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Zm4-12h6',
  },
  { href: '/downloads', key: 'nav.activity', icon: 'M12 4v11m-5-5 5 5 5-5M5 20h14' },
];

function TabBar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const activity = useActivity();
  const badge = activity.active + activity.failed;
  return (
    <nav
      aria-label={t('nav.label')}
      className="border-line fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-[#100f0e]/95 px-2 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur-md md:hidden"
    >
      {TABS.map((tab) => {
        const active =
          tab.href === '/downloads'
            ? /^\/(downloads|updates|sources)/.test(pathname)
            : isActive(pathname, tab.href);
        if (tab.href === '/search')
          return (
            <button
              key={tab.href}
              type="button"
              onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
              className="relative flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#8c867e]"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={tab.icon} />
              </svg>
              {t(tab.key)}
            </button>
          );
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'relative flex min-h-11 flex-col items-center justify-center gap-1 text-[11px]',
              active ? 'font-semibold text-white' : 'text-[#8c867e]',
            )}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d={tab.icon} />
            </svg>
            {t(tab.key)}
            {tab.href === '/downloads' && badge > 0 && (
              <span className="bg-fg text-bg absolute top-0 left-1/2 ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function Shortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <QuickSearch variant="overlay" />;
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
export function DownloadIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
function PuzzleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 4h4v3a2 2 0 1 0 4 0V4h3v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V4h5Z" />
    </svg>
  );
}
function SlidersIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

/** Content wrapper for pages without a hero: clears the fixed header. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cx(
        'mx-auto flex w-full max-w-[1760px] flex-col gap-6 px-4 pt-20 md:gap-7 md:px-10 md:pt-32',
        className,
      )}
    >
      {children}
    </main>
  );
}
