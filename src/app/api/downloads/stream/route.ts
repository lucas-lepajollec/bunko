export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { setTimeout } from 'node:timers/promises';
import { route, sse } from '@/lib/api';
import { snapshot } from '@/lib/downloads';
import { errorCode } from '@/lib/errors';
export const GET = route((r) =>
  sse(r, async (send, signal) => {
    while (!signal.aborted) {
      try {
        send('snapshot', await snapshot(signal));
      } catch (e) {
        send('error', { code: errorCode(e), message: 'Download status unavailable' });
      }
      try {
        await setTimeout(1500, undefined, { signal });
      } catch {
        break;
      }
    }
  }),
);
