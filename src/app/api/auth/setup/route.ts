export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { setup, authState, credentials } from '@/lib/auth';
import { body, json, route } from '@/lib/api';
export const POST = route(async (r) => {
  const cookie = await setup(r, await body(r, credentials));
  const response = json(
    authState(new Request(r.url, { headers: { cookie: cookie.split(';')[0] } })),
  );
  response.headers.set('Set-Cookie', cookie);
  return response;
}, false);
