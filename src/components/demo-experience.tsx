'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, Compass, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { setTheme, useTheme } from '@/lib/client/theme';
import { clearPersistentCache } from '@/lib/client/cache';
import { DEMO_INTRO_KEY, resetDemoState } from '@/lib/demo/handler';
import '../app/demo.css';

const LINKS = {
  site: 'https://bunko.lucas-homelab.fr',
  docs: 'https://docs.bunko.lucas-homelab.fr',
  source: 'https://github.com/lucas-lepajollec/bunko',
};

const emptySubscribe = () => () => {};

function readIntroSeen() {
  if (typeof window === 'undefined') return true;
  try {
    return window.sessionStorage.getItem(DEMO_INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

export function DemoExperience() {
  const { t, language } = useI18n();
  const currentTheme = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const [isGuideOpen, setGuideOpen] = useState(() => !readIntroSeen());
  const [announcement, setAnnouncement] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isGuideOpen && !dialog.open) {
      dialog.showModal();
      titleRef.current?.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    }
    if (!isGuideOpen && dialog.open) dialog.close();
  }, [isGuideOpen, mounted]);

  const closeGuide = () => {
    try {
      window.sessionStorage.setItem(DEMO_INTRO_KEY, '1');
    } catch {
      /* Ignore storage unavailability. */
    }
    setGuideOpen(false);
  };

  const handleReset = () => {
    setAnnouncement(t('demo.resetting'));
    resetDemoState();
    clearPersistentCache();
    window.location.reload();
  };

  if (!mounted) return null;

  const siteHref = language === 'en' ? LINKS.site : `${LINKS.site}/${language}`;
  const docsHref = `${LINKS.docs}/${language}/docs`;

  const cards = [
    { icon: Compass, title: t('demo.card.tryTitle'), body: t('demo.card.tryBody') },
    { icon: Sparkles, title: t('demo.card.simTitle'), body: t('demo.card.simBody') },
    { icon: ShieldCheck, title: t('demo.card.neverTitle'), body: t('demo.card.neverBody') },
  ];

  return createPortal(
    <>
      <div className={`bk-demo-chip${isGuideOpen ? ' is-hidden' : ''}`} data-demo-chip>
        <button
          type="button"
          onClick={() => setGuideOpen(true)}
          aria-label={t('demo.info')}
        >
          <span>{t('demo.chip')}</span>
          <CircleHelp size={14} aria-hidden="true" />
        </button>
        <span className="bk-demo-chip-sep" aria-hidden="true" />
        <button
          type="button"
          onClick={handleReset}
          aria-label={t('demo.resetAria')}
          title={t('demo.reset')}
        >
          <RotateCcw size={13} aria-hidden="true" />
          <span>{t('demo.reset')}</span>
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === dialogRef.current) closeGuide();
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeGuide();
        }}
        onClose={closeGuide}
        aria-labelledby="bk-demo-title"
        aria-describedby="bk-demo-lead"
        className="bk-demo-dialog"
      >
        <div className="bk-demo-inner">
          <div className="bk-demo-brand">
            {/* eslint-disable-next-line @next/next/no-img-element -- static local SVG mark */}
            <img src="/logo.svg" alt="" width={20} height={20} />
            <span>Bunko</span>
            <span className="bk-demo-badge">{t('demo.public')}</span>
          </div>

          <h2 ref={titleRef} id="bk-demo-title" tabIndex={-1} className="bk-demo-title">
            {t('demo.welcome.title')}
          </h2>
          <p id="bk-demo-lead" className="bk-demo-lead">
            {t('demo.welcome.lead')}
          </p>

          <div className="bk-demo-cards">
            {cards.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bk-demo-card">
                <div className="bk-demo-card-head">
                  <Icon size={14} aria-hidden="true" />
                  <span>{title}</span>
                </div>
                <p>{body}</p>
              </div>
            ))}
          </div>

          <div className="bk-demo-looks">
            <span className="bk-demo-label">{t('demo.look')}</span>
            <div className="bk-demo-look-list" role="radiogroup" aria-label={t('demo.look')}>
              {(['cine', 'bunko'] as const).map((lookId) => (
                <button
                  key={lookId}
                  type="button"
                  role="radio"
                  aria-checked={currentTheme.theme === lookId}
                  className="bk-demo-look"
                  onClick={() => setTheme({ theme: lookId })}
                >
                  {t(`appearance.theme.${lookId}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="bk-demo-footer">
            <nav className="bk-demo-links" aria-label={t('demo.public')}>
              <a href={siteHref} target="_blank" rel="noreferrer">
                {t('demo.site')}
              </a>
              <a href={docsHref} target="_blank" rel="noreferrer">
                {t('demo.docs')}
              </a>
              <a href={LINKS.source} target="_blank" rel="noreferrer">
                {t('demo.source')}
              </a>
            </nav>
            <button
              type="button"
              className="bk-demo-continue"
              data-demo-continue
              onClick={closeGuide}
            >
              {t('demo.continue')}
            </button>
          </div>
        </div>
      </dialog>
    </>,
    document.body,
  );
}
