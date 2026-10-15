export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { controlDownloader } from '@/lib/suwayomi';
import { downloadControl } from '@/lib/validation';
export const POST = route(async (r) =>
  json(await controlDownloader(await body(r, downloadControl))),
);
