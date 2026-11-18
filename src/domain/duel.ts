/**
 * Placement by duels, a binary insertion asked to the user: the work to place is compared with
 * the one in the middle of where it can still go, then the middle of the half left (about 7
 * questions for 100 works). Works already in order keep it; pending works are placed one by one.
 */
export interface DuelState<T> {
  sorted: T[];
  pending: T[];
  lo: number;
  hi: number;
  asked: number;
}
export type DuelAnswer = 'candidate' | 'against' | 'same';

/** Questions a binary insertion needs at most to place `count` works among `among`. */
export function duelQuestions(among: number, count: number) {
  let total = 0;
  for (let k = among; k < among + count; k++) total += Math.ceil(Math.log2(k + 1));
  return total;
}

/** Inserts every pending work that needs no more question. */
function settle<T>(s: DuelState<T>): DuelState<T> {
  let state = s;
  while (state.pending.length && state.lo >= state.hi) {
    const [work, ...rest] = state.pending;
    const sorted = [...state.sorted];
    sorted.splice(state.lo, 0, work);
    state = { ...state, sorted, pending: rest, lo: 0, hi: sorted.length };
  }
  return state;
}

export const startDuel = <T>(sorted: T[], pending: T[]): DuelState<T> =>
  settle({ sorted: [...sorted], pending: [...pending], lo: 0, hi: sorted.length, asked: 0 });

/** The current question: the work to place and the work it is compared with. */
export function duelQuestion<T>(s: DuelState<T>) {
  const mid = Math.floor((s.lo + s.hi) / 2);
  const candidate = s.pending[0];
  const against = s.sorted[mid];
  return candidate !== undefined && against !== undefined ? { candidate, against, mid } : null;
}

/** "The same" places the work right after the one it was compared with. */
export function answerDuel<T>(s: DuelState<T>, answer: DuelAnswer): DuelState<T> {
  const mid = Math.floor((s.lo + s.hi) / 2);
  return settle({
    ...s,
    asked: s.asked + 1,
    ...(answer === 'candidate'
      ? { hi: mid }
      : answer === 'against'
        ? { lo: mid + 1 }
        : { lo: mid + 1, hi: mid + 1 }),
  });
}
