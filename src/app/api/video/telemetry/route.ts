export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { tenantId } from '@/lib/tenant-context';

const ms = z.number().int().min(0).max(3_600_000).nullable().optional();
const report = z.object({
  outcome: z.enum(['playing', 'failed']),
  via: z.enum(['direct', 'relay', 'jellyfin']).nullable().optional(),
  discoveryMs: ms,
  selectionMs: ms,
  firstFrameMs: ms,
  fallbacks: z.number().int().min(0).max(50),
  errorType: z.enum(['network', 'decode', 'unsupported', 'timeout', 'hls']).nullable().optional(),
});

/**
 * One playback's timings from the player, written to the server log: source_discovery_ms,
 * source_selection_ms, time_to_first_frame_ms, stream_fallback_count, stream_error_type.
 * Numbers and categories only: no address, title or episode.
 */
export const POST = route(async (r) => {
  const m = await body(r, report);
  const part = (name: string, value: unknown) =>
    value === null || value === undefined ? '' : ` ${name}=${value}`;
  console.log(
    `[bunko] video playback (account ${tenantId()}): ${m.outcome}${part('via', m.via)}${part('source_discovery_ms', m.discoveryMs)}${part('source_selection_ms', m.selectionMs)}${part('time_to_first_frame_ms', m.firstFrameMs)} stream_fallback_count=${m.fallbacks}${part('stream_error_type', m.errorType)}`,
  );
  return json({ ok: true });
});
