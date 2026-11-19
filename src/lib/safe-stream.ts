import type { Readable } from 'node:stream';

/**
 * Bridge a Node Readable stream to a Web ReadableStream with backpressure and without letting
 * a client disconnect throw an uncaught `ERR_INVALID_STATE: Controller is already closed`.
 */
export function safeWebStream(stream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    stream.removeAllListeners();
    if (!stream.destroyed) stream.destroy();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (closed) return;
        const bytes =
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : chunk instanceof Uint8Array
              ? chunk
              : new Uint8Array(chunk);
        try {
          controller.enqueue(bytes);
          if (controller.desiredSize !== null && controller.desiredSize <= 0) stream.pause();
        } catch {
          finish();
        }
      });
      stream.on('end', () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* Client already closed the response stream. */
        }
      });
      stream.on('error', (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          /* Client already closed the response stream. */
        }
      });
      stream.on('close', () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* Stream destroyed after abort or error. */
        }
      });
    },
    pull() {
      if (!closed && stream.isPaused()) stream.resume();
    },
    cancel() {
      finish();
    },
  });
}
