/** Keep HTTP/1 connections available for navigation, JSON and the reader on LAN installs. */
export function createCoverLoader(limit = 2) {
  let active = 0;
  const queue: { start: () => void; cancel: () => void }[] = [];
  return async (url: string, signal: AbortSignal): Promise<Blob> => {
    signal.throwIfAborted();
    if (queue.length >= 64) throw new Error('Cover queue is full');
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
      const response = await fetch(url, {
        credentials: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      });
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
