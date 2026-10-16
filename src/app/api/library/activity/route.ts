export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { libraryActivity } from '@/lib/library-activity';
export const GET = route(() => json(libraryActivity()));
