export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { login, authenticate } from '@/lib/auth';
import { body, json, route } from '@/lib/api';
export const POST = route(async (r) => {
  const input = await body(r, z.object({ token: z.string().min(1).max(200) }));
  return new Response(JSON.stringify({ authenticated: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': login(r, input.token),
    },
  });
}, false);
export const GET = route((r) => {
  authenticate(r);
  return json({ authenticated: true });
});
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
