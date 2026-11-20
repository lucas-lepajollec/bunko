export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { stashSearch } from '@/lib/stash';

/** Indexed Stash groups and scenes by name, for linking a work by hand. */
export const GET = route((r) =>
  json(
    stashSearch(
      z
        .string()
        .max(200)
        .parse(new URL(r.url).searchParams.get('q') ?? ''),
    ),
  ),
);
