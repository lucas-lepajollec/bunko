'use client';
import { useEffect } from 'react';
import { clearPersistentCache } from '@/lib/client/cache';
import { useI18n } from '@/i18n/I18nProvider';

/**
 * Last-resort screen for a page that failed to render. Saved data is the usual suspect after an
 * update, so it is cleared before retrying.
 */
export default function PageError({ error }: { error: Error }) {
  const { t } = useI18n();
  useEffect(() => {
    clearPersistentCache();
    console.error(error);
    reloadOnceForStaleBuild(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-start justify-center gap-4 px-4">
      <h1 className="font-display text-3xl font-extrabold tracking-[-0.03em]">
        {t('crash.title')}
      </h1>
      <p className="text-mid">{t('crash.body')}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="bg-fg text-bg h-11 rounded-full px-5 font-semibold"
        >
          {t('crash.retry')}
        </button>
        <button
          type="button"
          // A full reload of the home page, so the in-memory cache starts empty.
          onClick={() => {
            history.replaceState(null, '', '/');
            window.location.reload();
          }}
          className="h-11 rounded-full bg-white/[0.08] px-5"
        >
          {t('crash.home')}
        </button>
      </div>
    </main>
  );
}

/**
 * After an update, a tab still running the previous build asks for script chunks that no longer
 * exist. Reload once (guarded per session) to pick up the new build instead of showing an error.
 */
export function reloadOnceForStaleBuild(error: Error) {
  const stale =
    /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
      `${error.name} ${error.message}`,
    );
  if (!stale) return;
  try {
    if (sessionStorage.getItem('bunko.reloaded') === '1') return;
    sessionStorage.setItem('bunko.reloaded', '1');
  } catch {
    return;
  }
  window.location.reload();
}
