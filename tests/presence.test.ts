import { afterEach, expect, it, vi } from 'vitest';
const { notePresence, inUse, anyoneInUse, cadence } = await import('@/lib/presence');

afterEach(() => vi.useRealTimers());

it('keeps the usual pace while an account is used, a slower one after half an hour away', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
  expect(inUse(7)).toBe(false);
  expect(cadence(15 * 60_000, 60 * 60_000, 7)).toBe(60 * 60_000);
  notePresence(7);
  expect(inUse(7)).toBe(true);
  expect(anyoneInUse()).toBe(true);
  expect(cadence(15 * 60_000, 60 * 60_000, 7)).toBe(15 * 60_000);
  // Never faster when idle than in use.
  expect(cadence(15 * 60_000, 5 * 60_000, 8)).toBe(15 * 60_000);
  vi.advanceTimersByTime(31 * 60_000);
  expect(inUse(7)).toBe(false);
  expect(anyoneInUse()).toBe(false);
});
