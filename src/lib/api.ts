import { trackRequest } from './job-stats';
import { ZodError, type ZodType } from 'zod';
import { userContext } from './user-context';
import { inTenant, tenantContext } from './tenant-context';
import { requireAdmin } from './auth';
import { authenticate, checkOrigin } from './auth';
import { AppError } from './errors';
import { startWorker } from './downloads';
import { withSourceLanguage } from './source-preferences';
import { sourceLanguage } from './source-language';
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export function failure(e: unknown) {
  if (e instanceof ZodError)
    return json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      },
      400,
    );
  if (e instanceof AppError)
    return json(
      { error: { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) } },
      e.status,
    );
  return json(
    { error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' } },
    500,
  );
}
export function route(handler: (r: Request) => Promise<Response> | Response, protect = true) {
  return async (r: Request) => {
    const done = trackRequest(new URL(r.url).pathname);
    try {
      const user = protect ? authenticate(r) : undefined;
      if (!['GET', 'HEAD'].includes(r.method)) checkOrigin(r);
      startWorker();
      return await userContext.run(user?.id ? user : undefined, async () => {
        if (!protect) return await tenantContext.exit(() => handler(r));
        return await inTenant(user!.id, () =>
          withSourceLanguage(
            sourceLanguage(new URL(r.url).searchParams.get('uiLanguage') ?? '') ??
              r.headers.get('accept-language') ??
              '',
            async () => {
              if (new URL(r.url).pathname.replace(/\/$/, '') === '/api/users') requireAdmin();
              return compressed(r, await handler(r));
            },
          ),
        );
      });
    } catch (e) {
      return failure(e);
    } finally {
      done();
    }
  };
}
/** JSON past this size is sent compressed (the library list of a large account is megabytes). */
const COMPRESS_FROM = 16 * 1024;
/**
 * Compress a large JSON answer when the browser accepts it: the standalone server does not do it
 * for route handlers. Gzip at a fast level: about a tenth of the bytes for little CPU.
 */
async function compressed(r: Request, response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (
    !type.includes('application/json') ||
    response.headers.has('content-encoding') ||
    !/\bgzip\b/.test(r.headers.get('accept-encoding') ?? '')
  )
    return response;
  const raw = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Accept-Encoding');
  if (raw.byteLength < COMPRESS_FROM)
    return new Response(raw, { status: response.status, headers });
  const { gzipSync, constants } = await import('node:zlib');
  const zipped = gzipSync(raw, { level: constants.Z_BEST_SPEED + 3 });
  headers.set('Content-Encoding', 'gzip');
  headers.set('Content-Length', String(zipped.byteLength));
  return new Response(zipped, { status: response.status, headers });
}
export async function body<T>(r: Request, schema: ZodType<T>, maxBytes = 1024 * 1024): Promise<T> {
  if (!r.headers.get('content-type')?.includes('application/json'))
    throw new AppError('CONTENT_TYPE', 'Use application/json', 415);
  const reader = r.body?.getReader();
  if (!reader) throw new AppError('VALIDATION_ERROR', 'JSON body is required');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes)
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          `Body exceeds ${Math.round(maxBytes / 1048576)} MiB`,
          413,
        );
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid JSON');
  }
  return schema.parse(value);
}
export function sse(
  request: Request,
  run: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(output) {
      // A browser that goes away can close the stream between two writes: writing or closing a
      // closed stream throws, and that error must never escape (it crashed the process).
      let open = true;
      const write = (text: string) => {
        if (!open || signal.aborted) return;
        try {
          output.enqueue(encoder.encode(text));
        } catch {
          open = false;
          controller.abort();
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
      try {
        await run(send, signal);
      } catch (e) {
        if (!signal.aborted)
          send('error', {
            code: e instanceof AppError ? e.code : 'STREAM_ERROR',
            message: 'Stream interrupted',
          });
      } finally {
        clearInterval(heartbeat);
        if (open && !controller.signal.aborted)
          try {
            output.close();
          } catch {
            /* Already closed by the client going away. */
          }
        open = false;
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
