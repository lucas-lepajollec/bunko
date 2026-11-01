export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { listTranslations, requestTranslations } from '@/lib/translations';
import { requirePermission } from '@/lib/auth';

const language = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/);

/** Translation jobs of one work (or all works). */
export const GET = route((r) => {
  const raw = new URL(r.url).searchParams.get('trackedId');
  const trackedId = raw === null ? undefined : z.coerce.number().int().positive().parse(raw);
  return json(listTranslations(trackedId));
});

/** Queue owned files of a book/novel for translation through TraDoc. */
export const POST = route(async (r) => {
  requirePermission('translate');
  const input = await body(
    r,
    z
      .object({
        trackedId: z.number().int().positive(),
        paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
        sourceLang: language,
        targetLang: language,
        provider: z.string().trim().min(1).max(100).optional(),
        model: z.string().trim().min(1).max(300).optional(),
        mode: z.enum(['replace', 'separate']),
      })
      .strict(),
  );
  return json(await requestTranslations(input), 202);
});
