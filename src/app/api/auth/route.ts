export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { login, authState, credentials } from '@/lib/auth';
import { body, json, route } from '@/lib/api';
export const POST = route(async (r) => {
  const cookie = await login(r, await body(r, credentials));
  const response = json(
    authState(new Request(r.url, { headers: { cookie: cookie.split(';')[0] } })),
  );
  response.headers.set('Set-Cookie', cookie);
  return response;
}, false);
export const GET = route((r) => json(authState(r)), false);
export const DELETE = route(
  () =>
    new Response(null, {
      status: 204,
      headers: {
        'Set-Cookie': 'kaviseerr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        'Cache-Control': 'no-store',
      },
    }),
);
