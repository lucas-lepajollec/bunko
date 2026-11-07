'use client';
import { useState } from 'react';
import { Star } from 'lucide-react';
import type { TrackedMedia } from '@/types/shared';
import { KIND_IDS, kindOfMedia, type Kind } from '@/domain/kinds';
import { formatRating } from '@/domain/library-mark';
import { useViewState } from '@/lib/client/view-state';
import { useI18n } from '@/i18n/I18nProvider';
import { MediaLink } from './media-link';
import { Cover, Empty, SectionHeading, cx, smallButton } from './ui';

const SHOWN = 10;

/**
 * The user's rankings, one per kind: every rated work, best first (equal scores by title).
 * Built from the ratings alone, so it is always in step with them.
 */
export function Tops({ entries }: { entries: TrackedMedia[] }) {
  const { t, n, locale } = useI18n();
  const rated = entries.filter((e) => e.rating != null && !e.partOf);
  const byKind = new Map<Kind, TrackedMedia[]>();
  for (const e of rated) {
    const k = kindOfMedia(e.media);
    byKind.set(k, [...(byKind.get(k) ?? []), e]);
  }
  const kinds = KIND_IDS.filter((k) => byKind.has(k));
  const [chosen, setChosen] = useViewState<Kind | ''>('top', '', ['', ...KIND_IDS]);
  // Opens on the kind with the most rated works.
  const largest = [...kinds].sort((a, b) => byKind.get(b)!.length - byKind.get(a)!.length)[0];
  const kind = chosen && byKind.has(chosen) ? chosen : largest;
  const [all, setAll] = useState(false);
  const ranked = [...(kind ? (byKind.get(kind) ?? []) : [])].sort(
    (a, b) => b.rating! - a.rating! || a.title.localeCompare(b.title),
  );
  return (
    <section id="tops" className="scroll-mt-28 flex flex-col gap-5">
      <SectionHeading title={t('tops.title')} aside={t('tops.aside')} />
      {!kinds.length ? (
        <Empty title={t('tops.empty')}>{t('tops.emptyBody')}</Empty>
      ) : (
        <>
          <div
            className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:px-0"
            role="group"
            aria-label={t('catalog.kind')}
          >
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setChosen(k);
                  setAll(false);
                }}
                className={cx(
                  'h-[34px] shrink-0 rounded-full px-3.5',
                  kind === k ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
                )}
              >
                {t(`kind.${k}`)}
                <span className="text-muted ml-1.5 font-serif italic">
                  {n(byKind.get(k)!.length)}
                </span>
              </button>
            ))}
          </div>
          <ol className="grid gap-x-8 gap-y-1 md:grid-cols-2">
            {(all ? ranked : ranked.slice(0, SHOWN)).map((e, i) => (
              <li key={e.id}>
                <MediaLink
                  media={e.media}
                  className="flex items-center gap-4 rounded-2xl px-2 py-2 hover:bg-white/[0.04]"
                >
                  <span className="font-display w-10 shrink-0 text-right text-3xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums">
                    {n(i + 1)}
                  </span>
                  <Cover
                    src={e.coverUrl ?? e.media.coverUrl}
                    fallbacks={e.coverFallbacks}
                    className="w-12 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#f5c518] px-2.5 py-1 text-sm font-bold text-black">
                    <Star className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden />
                    {formatRating(e.rating!, locale)}
                  </span>
                </MediaLink>
              </li>
            ))}
          </ol>
          {ranked.length > SHOWN && (
            <button
              type="button"
              className={cx(smallButton, 'self-start')}
              onClick={() => setAll(!all)}
            >
              {all ? t('tops.less') : t('tops.all', { count: n(ranked.length) })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
