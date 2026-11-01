export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { controlTranslation } from '@/lib/translations';
import { requirePermission } from '@/lib/auth';

export const POST = route(async (r) => {
  requirePermission('translate');
  const { id, action } = await body(
    r,
    z
      .object({
        id: z.number().int().positive(),
        action: z.enum(['pause', 'resume', 'cancel', 'retry', 'restore', 'remove']),
      })
      .strict(),
  );
  return json(await controlTranslation(id, action));
});
