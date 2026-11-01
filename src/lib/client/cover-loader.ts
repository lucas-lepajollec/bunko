/**
 * A failure worth retrying later (busy server, timeout, upstream hiccup), as opposed to an image
 * that does not exist. Callers keep the cover slot instead of falling back to "no cover".
 */
export class TransientCoverError extends Error {}

/**
 * Keep HTTP/1 connections available for navigation, JSON and the reader on LAN installs: four
 * of a browser's six connections per host, the rest stay free.
 */
export function createCoverLoader(limit = 4) {
  let active = 0;
  const queue: { start: () => void; cancel: () => void }[] = [];
  return async (url: string, signal: AbortSignal): Promise<Blob> => {
    signal.throwIfAborted();
    if (queue.length >= 256) throw new TransientCoverError('Cover queue is full');
    await new Promise<void>((resolve, reject) => {
      const task = {
        start: () => {
          signal.removeEventListener('abort', task.cancel);
          active++;
          resolve();
        },
        cancel: () => {
          const index = queue.indexOf(task);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      if (active < limit) task.start();
      else {
        queue.push(task);
        signal.addEventListener('abort', task.cancel, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          credentials: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new TransientCoverError('Cover request failed');
      }
      // 5xx/429: Bunko could not reach the artwork host right now; 4xx means it does not exist.
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        throw new TransientCoverError('Cover temporarily unavailable');
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
      const max = 15 * 1024 * 1024;
      if (
        !response.ok ||
        !/^image\/(?:jpeg|png|webp|gif|avif|x-icon|vnd\.microsoft\.icon)$/i.test(mime) ||
        Number(response.headers.get('content-length')) > max ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error('Cover unavailable');
      }
      const reader = response.body.getReader();
      const parts: ArrayBuffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) throw new Error('Cover exceeds size limit');
          parts.push(new Uint8Array(value).buffer);
        }
        if (!size) throw new Error('Empty cover');
        return new Blob(parts, { type: mime });
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      active--;
      queue.shift()?.start();
    }
  };
}

export const loadCover = createCoverLoader();
