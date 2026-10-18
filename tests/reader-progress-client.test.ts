import { afterEach, expect, it, vi } from 'vitest';
import { ReaderProgressWriter } from '@/lib/client/reader-progress';
const position = (page: number) => ({
  mediaId: 'anilist:1',
  chapterId: 10,
  number: 1,
  page,
  pageCount: 3,
});
afterEach(() => vi.useRealTimers());
it('saves completion immediately before quick navigation, without waiting for the debounce', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const writer = new ReaderProgressWriter(send);
  writer.update(position(0));
  writer.update(position(1));
  writer.update(position(2));
  await writer.close();
  expect(send).toHaveBeenCalledExactlyOnceWith(position(2));
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});
it('flushes an intermediate page on exit and coalesces normal page turns', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const writer = new ReaderProgressWriter(send);
  writer.update(position(0));
  writer.update(position(1));
  await writer.close();
  expect(send).toHaveBeenCalledExactlyOnceWith(position(1));
});
it('serializes an in-flight page and a newer completion, retrying a transient failure once', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const send = vi
    .fn()
    .mockImplementationOnce(() => blocked)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const writer = new ReaderProgressWriter(send);
  writer.update(position(0));
  const saving = writer.flush();
  writer.update(position(2));
  finish();
  await saving;
  expect(send.mock.calls.map((c) => c[0].page)).toEqual([0, 2, 2]);
  await writer.close();
});
