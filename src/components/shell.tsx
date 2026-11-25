'use client';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_PATTERN } from '@/domain/account-rules';
import { setVideoServer } from '@/i18n/video-server';
import { SlidingHighlight } from './sliding-highlight';
import { TypesPanel, UniverseMenu, UniverseTab, activeLabel } from './universe-switch';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import type { AuthState, DownloadBatch, Extension, PublicSettings } from '@/types/shared';
import { PRODUCT_NAME } from '@/lib/client/brand';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { UI_LANGUAGES, type UiLanguage } from '@/i18n/messages';
import { UNAUTHORIZED_EVENT, send, useApi, batchesInterval } from '@/lib/client/api';
import { cx, errorText, field, primaryButton, Skeleton } from './ui';
import { DESKTOP_NAV_QUERY, OPEN_SEARCH_EVENT, QuickSearch } from './quick-search';
import { ActivityBell, ActivityCenter, ActivityPanel } from './activity';
import { Toaster } from './notify';
import { ScrollMemory } from './scroll-memory';
import { Select } from './select';
import {
  ChevronDown,
  ChevronRight,
  Download,
  ListOrdered,
  LogOut,
  Menu,
  Newspaper,
  Puzzle,
  Settings2,
  UserRound,
} from 'lucide-react';
import { clearPersistentCache, persistentCache } from '@/lib/client/cache';
import { getAmbient, getAmbientColor, subscribeAmbient } from '@/lib/client/ambient';
import { useUniverse } from '@/lib/client/universe';
import { applyTheme, getTheme, useLook } from '@/lib/client/theme';
import { isDemoMode } from '@/lib/demo-mode';
import { DemoExperience } from './demo-experience';

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => applyTheme(getTheme()), []);
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
  useEffect(() => {
    const onUnauthorized = () => void mutate(undefined, { revalidate: true });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [mutate]);
  // A neutral frame while the session is checked: no private data, but no blank page either.
  if (isLoading)
    return (
      <div className="min-h-dvh pt-[var(--app-safe-top)]" aria-busy="true">
        <div className="flex h-14 items-center gap-2.5 px-4 text-white md:h-20 md:px-[max(2.5rem,calc((100%-1760px)/2+2.5rem))]">
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
        recovery={Boolean(data?.recovery)}
        onDone={async () => {
          // A new session starts from a clean cache, whoever used this browser before.
          clearPersistentCache({ resume: true });
          // Reload: no list kept in this tab's memory (paged lists included) can outlive the
          // previous account.
          window.location.reload();
        }}
      />
    );
  return (
    <>
      <Ambient />
      <Header />
      <Shortcuts />
      <Suspense>
        <ScrollMemory />
      </Suspense>
      <div className="pt-[var(--app-safe-top)] pb-[calc(var(--app-tabbar-edge)+1.5rem)] desktop-nav:pb-0">
        {children}
      </div>
      <TabBar />
      <Toaster />
      {isDemoMode() && <DemoExperience />}
    </>
  );
}

/** The current artwork, blurred behind the page; only themes that use it show it (themes.css). */
function Ambient() {
  const src = useSyncExternalStore(subscribeAmbient, getAmbient, () => null);
  const color = useSyncExternalStore(subscribeAmbient, getAmbientColor, () => null);
  if (!src && !color) return null;
  return (
    <div
      aria-hidden
      className="ambient"
      style={color ? ({ ['--ambient-color' as string]: color } as React.CSSProperties) : undefined}
    >
      {/* A plain image: it sits behind the page, where the cover loader's visibility checks never fire.
          Hidden on phones (themes.css) where a pure CSS gradient avoids GPU blur stalls. */}
      {src && (
        /* eslint-disable-next-line @next/next/no-img-element -- decorative, already in the browser cache */
        <img src={src} alt="" referrerPolicy="no-referrer" decoding="async" />
      )}
    </div>
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
function AuthScreen({
  mode,
  recovery = false,
  onDone,
}: {
  mode: 'setup' | 'login';
  /** Restoring the first administrator: ask for the one-time code from the data volume. */
  recovery?: boolean;
  onDone: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
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
        ...(setup ? (recovery ? { recoveryCode: code.trim() } : { setupCode: code.trim() }) : {}),
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
      <div className="absolute top-[calc(var(--app-safe-top)+1rem)] right-[max(1rem,env(safe-area-inset-right))]">
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
            pattern={setup ? USERNAME_PATTERN.source : undefined}
            title={setup ? t('auth.usernameRule') : undefined}
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
            minLength={setup ? PASSWORD_MIN : 1}
            maxLength={PASSWORD_MAX}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cx(field, 'h-12 text-base')}
          />
          {setup && <span className="text-faint text-xs">{t('auth.passwordRule')}</span>}
        </label>
        {setup && (
          <label className="text-muted flex flex-col gap-2 text-sm">
            {recovery ? t('auth.recoveryCode') : t('auth.setupCode')}
            <input
              required
              autoComplete="one-time-code"
              placeholder={recovery ? undefined : 'XXXX-XXXX-XXXX'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={cx(field, 'h-12 text-base tracking-[0.2em]')}
            />
            <span className="text-faint text-xs">
              {recovery ? t('auth.recoveryHint') : t('auth.setupCodeHint')}
            </span>
          </label>
        )}
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
          disabled={busy || !username.trim() || !password || (setup && !code.trim())}
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
  { href: '/news', key: 'nav.news' },
  { href: '/lists', key: 'nav.lists' },
];

function useActivity() {
  const settings = useApi<PublicSettings>('/api/settings');
  // Texts and logos name the video server actually connected (Jellyfin or Emby).
  const videoServer = settings.data?.videoServer;
  useEffect(() => setVideoServer(videoServer), [videoServer]);
  const batches = useApi<DownloadBatch[]>('/api/downloads/batches', {
    refreshInterval: batchesInterval,
  });
  const extensions = useApi<Extension[]>(settings.data?.suwayomiUrl ? '/api/extensions' : null, {
    refreshInterval: 30 * 60_000,
  });
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

function useScrolled() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return solid;
}

function Header() {
  const look = useLook();
  return look === 'cine' ? <CineHeader /> : <DefaultHeader />;
}

/**
 * Ciné: brand and type on the left, the navigation centred in a floating pill (search opens in
 * place of the links, with a way back), the tools grouped on the right.
 */
function CineHeader() {
  const { t } = useI18n();
  const pathname = usePathname();
  const activity = useActivity();
  const solid = useScrolled();
  const [searching, setSearching] = useState(false);
  // Leaving the page closes the search.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setSearching(false);
  }
  useEffect(() => {
    // Ctrl+K and the other "search" entry points open the bar on tablets and up.
    const onOpen = () => window.matchMedia(DESKTOP_NAV_QUERY).matches && setSearching(true);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, []);
  const tool =
    'relative flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.1]';
  const {
    header,
    types: typesButton,
    bell,
    panel,
    open: menuOpen,
    close: closeMenu,
    toggle,
  } = useHeaderMenus(pathname);
  const universe = useUniverse();
  const typesShown =
    universe.ready &&
    (universe.enabled.length + (universe.allowAll ? 1 : 0) > 1 || universe.adultAllowed);
  return (
    <header
      ref={header}
      data-solid={solid}
      className="app-header fixed inset-x-0 top-0 z-40 grid grid-cols-[1fr_auto] items-center gap-4 [--app-header-height:4rem] desktop-nav:grid-cols-[1fr_auto_1fr] desktop-nav:[--app-header-height:6rem]"
    >
      {/* Over the page: a blur that fades out downwards (no bar, no edge), shown once scrolled;
          before that, a light shade for the artwork. */}
      <div
        aria-hidden
        data-on={solid}
        className="header-fade pointer-events-none absolute inset-x-0 top-0 -z-10 h-[calc(100%+32px)]"
      >
        <span />
        <span />
        <span />
      </div>
      <div
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-x-0 top-0 -z-10 h-[calc(100%+48px)] bg-gradient-to-b from-black/50 to-transparent transition-opacity duration-500 ease-out',
          solid ? 'opacity-0' : 'opacity-100',
        )}
      />
      <div className="flex min-w-0 items-center gap-4 lg:gap-5">
        <Link href="/" className="app-brand flex shrink-0 items-center gap-2.5 text-white">
          <Logo size={30} />
          <span className="font-display text-[26px] leading-none md:text-[30px]">
            {PRODUCT_NAME}
          </span>
        </Link>
        {typesShown && (
          <button
            ref={typesButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen === 'types'}
            onClick={() => toggle('types')}
            className={cx(
              'hidden h-[50px] items-center gap-2 rounded-full border px-5 text-[15px] backdrop-blur-xl transition-colors desktop-nav:flex',
              menuOpen === 'types'
                ? 'border-white/25 bg-white/[0.14] text-white'
                : 'text-mid border-white/12 bg-white/[0.07] hover:text-white',
            )}
          >
            {activeLabel(t, universe)}
            {universe.adultMode && <span className="text-warn text-[11px] font-semibold">18+</span>}
            <ChevronDown
              className={cx(
                'size-4 transition-transform duration-200',
                menuOpen === 'types' && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
        )}
      </div>
      <nav
        aria-label={t('nav.label')}
        className={cx(
          'app-nav-pill relative hidden h-[50px] items-center gap-0.5 p-1 text-[14px] backdrop-blur-xl desktop-nav:flex lg:text-[15px]',
          searching && 'w-[min(640px,calc(100vw-560px))] min-w-[380px]',
        )}
      >
        {searching ? (
          <QuickSearch variant="bar" onClose={() => setSearching(false)} />
        ) : (
          <>
            <SlidingHighlight />
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(pathname, n.href) ? 'page' : undefined}
                className="text-mid rounded-full px-3.5 py-2.5 transition-colors hover:text-white lg:px-4"
              >
                {t(n.key)}
              </Link>
            ))}
            <span aria-hidden className="mx-1 h-6 w-px bg-white/20" />
            <button
              type="button"
              aria-label={t('nav.search')}
              title={`${t('nav.search')} · Ctrl K`}
              onClick={() => setSearching(true)}
              className="flex size-10 items-center justify-center rounded-full text-white hover:bg-white/[0.1]"
            >
              <SearchIcon size={18} />
            </button>
          </>
        )}
      </nav>
      <div className="flex items-center justify-self-end desktop-nav:h-[50px] desktop-nav:rounded-full desktop-nav:border desktop-nav:border-white/12 desktop-nav:bg-white/[0.07] desktop-nav:px-1 desktop-nav:backdrop-blur-xl">
        <span ref={bell} className="flex">
          <ActivityBell open={menuOpen === 'activity'} onClick={() => toggle('activity')} />
        </span>
        <button
          type="button"
          aria-label={t('nav.search')}
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          className={cx(tool, 'desktop-nav:hidden')}
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
          className="hidden desktop-nav:flex"
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
          className="hidden desktop-nav:flex"
        >
          <PuzzleIcon />
          {activity.updates > 0 && (
            <span className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
          )}
        </IconLink>
        <IconLink href="/profile" label={t('profile.title')} className="hidden desktop-nav:flex">
          <UserRound className="size-[19px]" aria-hidden />
        </IconLink>
        <IconLink href="/settings" label={t('nav.settings')} className="hidden desktop-nav:flex">
          <SlidersIcon />
        </IconLink>
        <MobileMenu />
      </div>
      <HeaderPanel
        open={menuOpen}
        onClose={closeMenu}
        headerRef={header}
        typesRef={typesButton}
        bellRef={bell}
        panelRef={panel}
      />
    </header>
  );
}

type HeaderMenu = 'types' | 'activity';

/**
 * Ciné header menus share one panel: switching from one to the other slides and reshapes it
 * instead of closing and reopening. Outside clicks, Escape and navigation close it.
 */
function useHeaderMenus(pathname: string) {
  const header = useRef<HTMLElement>(null);
  const types = useRef<HTMLButtonElement>(null);
  const bell = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<HeaderMenu | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(null);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (
        !panel.current?.contains(target) &&
        !types.current?.contains(target) &&
        !bell.current?.contains(target)
      )
        setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return {
    header,
    types,
    bell,
    panel,
    open,
    close: () => setOpen(null),
    toggle: (menu: HeaderMenu) => setOpen((o) => (o === menu ? null : menu)),
  };
}

/** The shared panel under the Ciné header, placed under the button of the open menu. */
function HeaderPanel({
  open,
  onClose,
  headerRef,
  typesRef,
  bellRef,
  panelRef,
}: {
  open: HeaderMenu | null;
  onClose: () => void;
  headerRef: React.RefObject<HTMLElement | null>;
  typesRef: React.RefObject<HTMLButtonElement | null>;
  bellRef: React.RefObject<HTMLSpanElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const content = useRef<HTMLDivElement>(null);
  // The last menu stays inside briefly while the panel fades out, then unmounts so background
  // polling (jobs, updates) and observers stop completely once closed.
  const [shown, setShown] = useState<HeaderMenu | null>(open);
  if (open && open !== shown) setShown(open);
  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => setShown(null), 160);
    return () => clearTimeout(timer);
  }, [open, shown]);
  const [box, setBox] = useState<{ left: number; width: number; caret: number } | null>(null);
  const [height, setHeight] = useState(0);
  // Geometry moves smoothly between menus, but appears in place when the panel opens.
  const [glide, setGlide] = useState(false);
  if (!open && glide) setGlide(false);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = (
        open === 'types' ? typesRef.current : bellRef.current
      )?.getBoundingClientRect();
      const frame = headerRef.current?.getBoundingClientRect();
      if (!anchor || !frame) return;
      const width = Math.min(open === 'types' ? 720 : 440, window.innerWidth - 24);
      const wanted = open === 'types' ? anchor.left : anchor.right - width;
      const left = Math.max(12, Math.min(wanted, window.innerWidth - 12 - width)) - frame.left;
      const rawCaret = anchor.left + anchor.width / 2 - frame.left - left;
      const caret = Math.max(28, Math.min(width - 28, rawCaret));
      setBox({ left, width, caret });
    };
    let second = 0;
    const first = requestAnimationFrame(() => {
      place();
      second = requestAnimationFrame(() => setGlide(true));
    });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      window.removeEventListener('resize', place);
    };
  }, [open, headerRef, typesRef, bellRef]);
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, box]);
  if (!shown || !box) return null;
  return (
    <div
      ref={panelRef}
      aria-hidden={!open}
      className={cx(
        'ui-panel absolute top-[calc(100%-6px)] z-50 rounded-[24px] border bg-panel text-sm',
        glide &&
          'transition-[left,width,height] duration-[260ms] ease-[cubic-bezier(0.2,0.9,0.3,1)]',
        open ? 'header-panel-in' : 'header-panel-out pointer-events-none invisible opacity-0',
      )}
      style={{ left: box.left, width: box.width, height: height || undefined }}
    >
      <svg
        aria-hidden
        width="14"
        height="7"
        viewBox="0 0 14 7"
        className={cx(
          'pointer-events-none absolute -top-[7px] block',
          glide && 'transition-[left] duration-[260ms] ease-[cubic-bezier(0.2,0.9,0.3,1)]',
        )}
        style={{ left: box.caret - 7 }}
      >
        <path
          d="M0 7 L6.2 0.8 Q7 0 7.8 0.8 L14 7 Z"
          fill="color-mix(in oklab, var(--color-panel) 96%, transparent)"
        />
        <path
          d="M0.5 7 L6.2 1.3 Q7 0.5 7.8 1.3 L13.5 7"
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="1"
        />
      </svg>
      <div className="overflow-hidden rounded-[24px]" style={{ height: height || undefined }}>
        <div
          ref={content}
          key={shown}
          className="header-panel-content flex flex-col"
          style={{ maxHeight: 'min(76vh, calc(100dvh - 120px - var(--app-safe-top)))' }}
        >
          {shown === 'types' ? <TypesPanel onDone={onClose} /> : <ActivityPanel />}
        </div>
      </div>
    </div>
  );
}

function DefaultHeader() {
  const { t } = useI18n();
  const pathname = usePathname();
  const activity = useActivity();
  const solid = useScrolled();
  return (
    <header
      data-solid={solid}
      className={cx(
        'app-header',
        // Content aligns with the 1760px page column on wide screens; no hard edge under the bar.
        'fixed inset-x-0 top-0 z-40 flex items-center gap-6 transition-[background-color,backdrop-filter] duration-300 [--app-header-height:3.5rem] md:gap-5 desktop-nav:[--app-header-height:5rem] xl:gap-11',
        solid ? 'bg-bg/90 backdrop-blur-md' : 'bg-gradient-to-b from-black/45 to-transparent',
      )}
    >
      <Link href="/" className="app-brand flex shrink-0 items-center gap-2.5 text-white">
        <Logo />
        <span className="font-display text-[19px] font-extrabold tracking-[-0.03em] md:text-[21px]">
          {PRODUCT_NAME}
        </span>
      </Link>
      <UniverseMenu />
      <nav
        aria-label={t('nav.label')}
        className="app-nav hidden gap-4 text-[13px] desktop-nav:flex xl:gap-7 xl:text-[15px]"
      >
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(pathname, n.href) ? 'page' : undefined}
            className={cx(
              'app-nav-link',
              isActive(pathname, n.href) ? 'font-semibold text-white' : 'text-mid hover:text-white',
            )}
          >
            {t(n.key)}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <ActivityCenter />
        <QuickSearch variant="inline" />
        <button
          type="button"
          aria-label={t('nav.search')}
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          className="relative flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.08] xl:hidden"
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
          className="hidden desktop-nav:flex"
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
          className="hidden desktop-nav:flex"
        >
          <PuzzleIcon />
          {activity.updates > 0 && (
            <span className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
          )}
        </IconLink>
        <IconLink href="/profile" label={t('profile.title')} className="hidden desktop-nav:flex">
          <UserRound className="size-[19px]" aria-hidden />
        </IconLink>
        <IconLink href="/settings" label={t('nav.settings')} className="hidden desktop-nav:flex">
          <SlidersIcon />
        </IconLink>
        <MobileMenu />
      </div>
    </header>
  );
}

/**
 * Phones: everything that does not fit the tab bar, in a bubble under the ☰ button, like the
 * desktop header menus.
 */
function MobileMenu() {
  const { t } = useI18n();
  const pathname = usePathname();
  const auth = useApi<AuthState>('/api/auth');
  const { mutate } = useSWRConfig();
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Measured from the button when the menu opens: the bubble hangs under it, its caret on it.
  const [anchor, setAnchor] = useState({ top: 58, right: 12, caret: 19 });
  // Navigating closes the menu.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  // Activity (downloads, updates) lives here on phones, with its count.
  const activity = useActivity();
  const badge = activity.active + activity.failed;
  const links = [
    { href: '/profile', label: t('profile.title'), Icon: UserRound },
    { href: '/news', label: t('nav.news'), Icon: Newspaper },
    { href: '/lists', label: t('nav.lists'), Icon: ListOrdered },
    { href: '/downloads', label: t('nav.downloads'), badge, Icon: Download },
    { href: '/sources', label: t('nav.sources'), Icon: Puzzle },
    { href: '/settings', label: t('nav.settings'), Icon: Settings2 },
  ];
  const name = auth.data?.username ?? '';
  const row = 'flex min-h-12 items-center gap-3 rounded-2xl px-2.5 text-[15.5px]';
  const tile = 'flex size-[34px] shrink-0 items-center justify-center rounded-[11px]';
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        const box = trigger.current?.getBoundingClientRect();
        if (next && box) {
          const right = Math.max(8, window.innerWidth - box.right - 4);
          const caret = window.innerWidth - (box.left + box.width / 2) - right;
          setAnchor({ top: box.bottom + 6, right, caret });
        }
        setOpen(next);
      }}
    >
      <Dialog.Trigger
        ref={trigger}
        aria-label={t('nav.menu')}
        className="relative flex size-11 items-center justify-center rounded-full text-white hover:bg-white/[0.08] data-[state=open]:bg-white/[0.14] desktop-nav:hidden"
      >
        <Menu className="size-5" aria-hidden />
        {badge > 0 && (
          <span
            aria-hidden
            className="bg-fg absolute top-2 right-2 size-2 rounded-full ring-2 ring-panel"
          />
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content
          ref={bubble}
          onOpenAutoFocus={(e) => {
            // Opened by touch: no focus ring on the first entry, keyboard users tab from here.
            e.preventDefault();
            bubble.current?.focus();
          }}
          className="ui-panel mobile-menu fixed z-50 flex w-[min(366px,calc(100vw-24px))] flex-col rounded-[24px] border border-white/10 bg-panel outline-none"
          style={{
            top: anchor.top,
            right: anchor.right,
            maxHeight: `calc(100dvh - ${anchor.top}px - var(--app-tabbar-edge) - 12px)`,
            transformOrigin: `calc(100% - ${anchor.caret}px) top`,
          }}
        >
          <svg
            aria-hidden
            width="14"
            height="7"
            viewBox="0 0 14 7"
            className="pointer-events-none absolute -top-[7px] block"
            style={{ right: anchor.caret - 8 }}
          >
            <path
              d="M0 7 L6.2 0.8 Q7 0 7.8 0.8 L14 7 Z"
              fill="color-mix(in oklab, var(--color-panel) 96%, transparent)"
            />
            <path
              d="M0.5 7 L6.2 1.3 Q7 0.5 7.8 1.3 L13.5 7"
              fill="none"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="1"
            />
          </svg>
          <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain rounded-[24px]">
            <div className="flex items-center gap-3 px-[18px] pt-4 pb-3">
              <span
                aria-hidden
                className="bg-fg text-bg flex size-10 shrink-0 items-center justify-center rounded-full text-[17px] font-bold uppercase"
              >
                {name.slice(0, 1) || '·'}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <Dialog.Title className="truncate text-[17px] font-bold">
                  {name || PRODUCT_NAME}
                </Dialog.Title>
                <Dialog.Description className="text-muted text-[12.5px]">
                  {auth.data?.role ? t(`users.role.${auth.data.role}`) : PRODUCT_NAME}
                </Dialog.Description>
              </span>
            </div>
            <nav className="flex flex-col gap-0.5 px-3 pb-2" aria-label={t('nav.menu')}>
              {links.map(({ href, label, Icon, ...l }) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={isActive(pathname, href) ? 'page' : undefined}
                  className={cx(
                    row,
                    'active:bg-white/[0.06]',
                    isActive(pathname, href)
                      ? 'bg-white/[0.08] font-semibold text-white'
                      : 'text-white/85',
                  )}
                >
                  <span aria-hidden className={cx(tile, 'text-mid bg-white/[0.06]')}>
                    <Icon className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {'badge' in l && Boolean(l.badge) && (
                    <span className="bg-fg text-bg flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold">
                      {l.badge}
                    </span>
                  )}
                  <ChevronRight className="text-muted size-4 shrink-0" aria-hidden />
                </Link>
              ))}
            </nav>
            <span aria-hidden className="bg-line mx-3 h-px shrink-0" />
            <div className="px-3 pt-2 pb-3">
              <button
                type="button"
                onClick={async () => {
                  await send('/api/auth', 'DELETE').catch(() => undefined);
                  clearPersistentCache();
                  setOpen(false);
                  await mutate('/api/auth');
                }}
                className={cx(row, 'text-bad w-full text-left active:bg-white/[0.06]')}
              >
                <span aria-hidden className={cx(tile, 'bg-bad/10')}>
                  <LogOut className="size-[18px]" />
                </span>
                {t('settings.signOut')}
              </button>
            </div>
          </div>
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
];

function TabBar() {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('nav.label')}
      className="app-nav-pill app-tabbar fixed z-40 mx-auto flex max-w-[420px] gap-0.5 p-1 desktop-nav:hidden"
    >
      {/* Icons only; the current page's tab opens into a white pill with its name. The type
          picker closes the bar. */}
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-label={t(tab.key)}
          aria-current={isActive(pathname, tab.href) ? 'page' : undefined}
          className="app-tabbar-item"
        >
          <svg
            width="20"
            height="20"
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
          <span aria-hidden>{t(tab.key)}</span>
        </Link>
      ))}
      <UniverseTab />
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
        'mx-auto flex w-full min-w-0 max-w-[1760px] flex-col gap-6 px-4 pt-20 pb-16 md:gap-7 md:px-10 md:pt-32',
        className,
      )}
    >
      {children}
    </main>
  );
}
