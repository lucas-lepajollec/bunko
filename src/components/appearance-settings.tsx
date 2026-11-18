'use client';
import { Check } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { THEMES, TONE_SWATCHES, setTheme, useTheme, type ThemeId } from '@/lib/client/theme';
import { cx } from './ui';

/** How each theme sets type, so its card previews it whatever theme is active. */
const PREVIEW: Record<ThemeId, { display: string; style: React.CSSProperties; radius: number }> = {
  bunko: {
    display: "'Bricolage Grotesque Variable', sans-serif",
    style: { fontWeight: 800, letterSpacing: '-0.04em' },
    radius: 4,
  },
  cine: {
    display: "'Anton', sans-serif",
    style: { textTransform: 'uppercase', letterSpacing: '0.01em' },
    radius: 10,
  },
  aurore: {
    display: "'Inter Variable', sans-serif",
    style: { fontWeight: 700, letterSpacing: '-0.04em' },
    radius: 10,
  },
  edition: {
    display: "'Fraunces Variable', Georgia, serif",
    style: { fontStyle: 'italic', fontWeight: 360, letterSpacing: '-0.03em' },
    radius: 0,
  },
};

/** Réglages → Apparence: the interface theme and its colour, for this device. */
export function AppearanceSettings() {
  const { t } = useI18n();
  const current = useTheme();
  const active = THEMES.find((x) => x.id === current.theme) ?? THEMES[0];
  return (
    <div className="flex flex-col gap-8">
      <p className="text-mid text-sm leading-relaxed">{t('appearance.hint')}</p>
      <div
        role="radiogroup"
        aria-label={t('appearance.theme')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {THEMES.map((theme) => {
          const on = theme.id === current.theme;
          const tone = on ? current.tone : theme.tones[0];
          const [bg, accent] = TONE_SWATCHES[tone];
          const p = PREVIEW[theme.id];
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setTheme({ theme: theme.id })}
              className={cx(
                'flex flex-col gap-3 rounded-2xl border p-3 text-left transition-colors',
                on ? 'border-fg bg-white/[0.06]' : 'border-line hover:bg-white/[0.04]',
              )}
            >
              <span
                aria-hidden
                className="relative flex h-28 items-end gap-2 overflow-hidden p-3"
                style={{
                  background: bg,
                  color: theme.light ? '#141210' : '#f4f1ea',
                  borderRadius: Math.max(p.radius, 2),
                }}
              >
                <span
                  className="flex-1 text-[34px] leading-[0.9]"
                  style={{ fontFamily: p.display, ...p.style }}
                >
                  Bunko
                </span>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="block w-7 shrink-0"
                    style={{
                      aspectRatio: '2 / 3',
                      borderRadius: p.radius / 2,
                      background: i === 0 ? accent : theme.light ? '#14121022' : '#ffffff22',
                    }}
                  />
                ))}
              </span>
              <span className="flex items-start gap-2 px-1">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{t(`appearance.theme.${theme.id}`)}</span>
                  <span className="text-muted text-[13px] leading-snug">
                    {t(`appearance.themeHint.${theme.id}`)}
                  </span>
                </span>
                {on && <Check className="mt-0.5 size-4 shrink-0" aria-hidden />}
              </span>
            </button>
          );
        })}
      </div>
      {active.tones.length > 1 && (
        <div className="flex flex-col gap-3">
          <span className="text-sm">{t('appearance.tone')}</span>
          <div role="radiogroup" aria-label={t('appearance.tone')} className="flex flex-wrap gap-2">
            {active.tones.map((tone) => {
              const [bg, accent] = TONE_SWATCHES[tone];
              const on = tone === current.tone;
              return (
                <button
                  key={tone}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setTheme({ tone })}
                  className={cx(
                    'ui-pill inline-flex h-11 items-center gap-2.5 rounded-full border pr-4 pl-1.5 text-sm transition-colors',
                    on ? 'border-fg font-semibold' : 'border-line hover:bg-white/[0.05]',
                  )}
                >
                  <span
                    aria-hidden
                    className="relative block size-8 overflow-hidden rounded-full border border-white/20"
                    style={{ background: bg }}
                  >
                    <span
                      className="absolute inset-y-0 right-0 w-1/2"
                      style={{ background: accent }}
                    />
                  </span>
                  {t(`appearance.tone.${tone}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
