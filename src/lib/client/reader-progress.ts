import type { ReaderProgressUpdate } from '@/types/shared';

/** One reader lifetime: coalesce turns, serialize writes, flush completion/navigation, bound retries. */
export class ReaderProgressWriter {
  private pending?: ReaderProgressUpdate;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private closed = false;
  constructor(private readonly write: (value: ReaderProgressUpdate) => Promise<unknown>) {}
  update(value: ReaderProgressUpdate) {
    this.closed = false;
    this.pending = value;
    clearTimeout(this.timer);
    if (value.page === value.pageCount - 1) void this.flush();
    else this.timer = setTimeout(() => void this.flush(), 1200);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (!this.pending) return Promise.resolve();
    this.running = (async () => {
      while (this.pending) {
        const value = this.pending;
        this.pending = undefined;
        try {
          await this.write(value);
        } catch {
          // Retry once while the reader is still active; never replay a previous account's data.
          if (!this.closed) {
            try {
              await this.write(value);
            } catch {
              /* A later page/exit can still be saved. */
            }
          }
        }
      }
    })().finally(() => {
      this.running = undefined;
      if (this.pending) return this.flush();
    });
    return this.running;
  }
  close() {
    this.closed = true;
    return this.flush();
  }
}
