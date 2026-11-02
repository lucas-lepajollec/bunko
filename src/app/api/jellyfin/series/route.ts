export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { jellyfinSeriesList } from '@/lib/jellyfin';

/** Indexed Jellyfin series (name search) for linking a work by hand. */
export const GET = route((r) =>
  json(
    jellyfinSeriesList(
      z
        .string()
        .max(200)
        .parse(new URL(r.url).searchParams.get('q') ?? ''),
    ),
  ),
);
