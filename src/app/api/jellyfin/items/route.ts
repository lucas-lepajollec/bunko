export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { jellyfinItems } from '@/lib/jellyfin';

/**
 * Every episode (or the film) of indexed Jellyfin series, for linking episodes by hand:
 * `seriesId=a,b` lists each series a work draws on, one after another.
 */
export const GET = route((r) =>
  json(
    z
      .string()
      .min(1)
      .max(1000)
      .parse(new URL(r.url).searchParams.get('seriesId'))
      .split(',')
      .slice(0, 20)
      .flatMap((id) => jellyfinItems(z.string().min(1).max(100).parse(id))),
  ),
);
