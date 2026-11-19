export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { jellyfinItems } from '@/lib/jellyfin';

/** Every episode (or the film) of one indexed Jellyfin series, for linking episodes by hand. */
export const GET = route((r) =>
  json(
    jellyfinItems(z.string().min(1).max(100).parse(new URL(r.url).searchParams.get('seriesId'))),
  ),
);
