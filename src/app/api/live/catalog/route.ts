export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { homeCountries, liveCatalog } from '@/lib/live/live';

export const GET = route(async (r) => {
  const p = z
    .object({
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      category: z
        .string()
        .regex(/^[a-z]{2,20}$/)
        .optional(),
      q: z.string().max(100).optional(),
      all: z.enum(['1']).optional(),
      page: z.coerce.number().int().min(1).max(500).default(1),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(
    await liveCatalog({
      ...p,
      all: p.all === '1',
      home: homeCountries(r.headers.get('accept-language')),
    }),
  );
});
