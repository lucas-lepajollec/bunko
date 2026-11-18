'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import type { TrackedMedia } from '@/types/shared';
import { answerDuel, duelQuestion, duelQuestions, startDuel, type DuelAnswer } from '@/domain/duel';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, smallButton } from './ui';

/**
 * Placement by duels: "which one do you prefer?" between the work to place and the one in the
 * middle of where it can go, then the middle of the half left (a binary insertion: about 7
 * questions for 100 works). "The same" places it right after. Works already in order (`sorted`)
 * keep their order; `pending` are placed one after the other.
 */
export function Duel({
  title,
  sorted,
  pending,
  onDone,
  onCancel,
}: {
  title: string;
  sorted: TrackedMedia[];
  pending: TrackedMedia[];
  onDone: (order: number[]) => void;
  onCancel: () => void;
}) {
  const { t, n } = useI18n();
  const [state, setState] = useState(() => startDuel(sorted, pending));
  const total = duelQuestions(sorted.length, pending.length);
  const question = duelQuestion(state);
  // Nothing to compare with: placed without a question.
  const finished = useRef(false);
  useEffect(() => {
    if (state.pending.length || finished.current) return;
    finished.current = true;
    onDone(state.sorted.map((w) => w.id));
  }, [state, onDone]);
  const answer = (choice: DuelAnswer) => setState(answerDuel(state, choice));
  const card = (work: TrackedMedia, hint: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl bg-white/[0.06] p-3 text-left transition-colors hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-white"
    >
      <Cover src={work.coverUrl ?? work.media.coverUrl} fallbacks={work.coverFallbacks} />
      <span className="line-clamp-2 font-semibold">{work.title}</span>
      <span className="text-muted text-xs">{hint}</span>
    </button>
  );
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/80" />
        <Dialog.Content className="anim-dialog bg-bg border-line fixed inset-x-3 top-1/2 z-50 mx-auto flex max-h-[92vh] max-w-[640px] -translate-y-1/2 flex-col items-center gap-5 overflow-y-auto rounded-3xl border p-5 outline-none md:p-7">
          <div className="flex flex-col items-center gap-1 text-center">
            <span className="text-muted text-xs tracking-[0.06em] uppercase">
              {title} ·{' '}
              {t('duel.progress', { n: n(Math.min(state.asked + 1, total)), total: n(total) })}
            </span>
            <Dialog.Title className="font-display text-[28px] leading-tight font-extrabold tracking-[-0.03em]">
              {t('duel.question')}
            </Dialog.Title>
            <Dialog.Description className="text-mid font-serif text-lg italic">
              {t('duel.hint')}
            </Dialog.Description>
          </div>
          {question && (
            <div className="flex w-full items-center gap-3 md:gap-5">
              {card(question.candidate, t('duel.placing'), () => answer('candidate'))}
              <span className="text-muted font-serif text-xl italic">{t('duel.or')}</span>
              {card(question.against, t('duel.at', { n: n(question.mid + 1) }), () =>
                answer('against'),
              )}
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className={smallButton} onClick={() => answer('same')}>
              {t('duel.same')}
            </button>
            <button
              type="button"
              className="text-mid px-3 text-sm hover:text-white"
              onClick={onCancel}
            >
              {t('common.cancel')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
