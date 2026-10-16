export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { changePassword, authState, passwordChange } from '@/lib/auth';
import { body, json, route } from '@/lib/api';
export const POST = route(async (r) => {
  const cookie = await changePassword(r, await body(r, passwordChange));
  const response = json(
    authState(new Request(r.url, { headers: { cookie: cookie.split(';')[0] } })),
  );
  response.headers.set('Set-Cookie', cookie);
  return response;
});
