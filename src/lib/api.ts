import { ZodError, type ZodType } from 'zod';
import { currentUser, userContext, asServer } from './user-context';
import { authenticate, checkOrigin } from './auth';
import { AppError } from './errors';
import { startWorker } from './downloads';
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
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
  return json(
    { error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' } },
    500,
  );
}
export function route(handler: (r: Request) => Promise<Response> | Response, protect = true) {
  return async (r: Request) => {
    try {
      const user = protect ? authenticate(r) : undefined;
      if (!['GET', 'HEAD'].includes(r.method)) checkOrigin(r);
      asServer(() => startWorker());
      return await userContext.run(user?.id ? user : undefined, async () => {
        if (protect) authorizeRoute(r);
        return await handler(r);
      });
    } catch (e) {
      return failure(e);
    }
  };
}
/** Deny new endpoints by default for members. Body-dependent permissions are checked by handlers. */
function authorizeRoute(request: Request) {
  if (currentUser()?.role !== 'member') return;
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  const method = request.method;
  const reads = new Set([
    '/api/auth',
    '/api/settings',
    '/api/me',
    '/api/search',
    '/api/search/stream',
    '/api/releases',
    '/api/planning',
    '/api/home',
    '/api/discover',
    '/api/genres',
    '/api/media',
    '/api/media/sources',
    '/api/sources',
    '/api/sources/preferences',
    '/api/updates',
    '/api/library/activity',
    '/api/tracked',
    '/api/tracked/covers',
    '/api/manga/chapters',
    '/api/downloads',
    '/api/downloads/stream',
    '/api/downloads/batches',
    '/api/kavita/status',
    '/api/kavita/series',
    '/api/kavita/image',
    '/api/suwayomi/image',
  ]);
  const allowed =
    method === 'GET' || method === 'HEAD'
      ? reads.has(path) ||
        /^\/api\/covers\/[1-9]\d*$/.test(path) ||
        /^\/api\/sources\/[1-9]\d*\/filters$/.test(path)
      : (method === 'PATCH' && ['/api/me', '/api/tracked', '/api/media/adult'].includes(path)) ||
        (method === 'DELETE' && ['/api/auth', '/api/tracked'].includes(path)) ||
        (method === 'POST' &&
          [
            '/api/auth/password',
            '/api/tracked',
            '/api/downloads/enqueue',
            '/api/downloads/batches',
            '/api/downloads/control',
            '/api/manga/chapters',
            '/api/kavita/track',
          ].includes(path)) ||
        (method === 'POST' && /^\/api\/sources\/[1-9]\d*\/browse$/.test(path));
  if (!allowed) throw new AppError('FORBIDDEN', 'Administrator access required', 403);
}
export async function body<T>(r: Request, schema: ZodType<T>): Promise<T> {
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
      if (size > 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 'Body exceeds 1 MiB', 413);
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
      const send = (event: string, data: unknown) => {
        if (!signal.aborted)
          output.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!signal.aborted) output.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);
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
        if (!controller.signal.aborted) output.close();
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
