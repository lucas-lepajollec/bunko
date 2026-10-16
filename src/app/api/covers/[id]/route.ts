import { z } from 'zod';
import { route } from '@/lib/api';
import { storedCoverResponse } from '@/lib/stored-covers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route((request) => {
  const id = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(request.url).pathname.split('/').at(-1));
  return storedCoverResponse(request, id);
});
