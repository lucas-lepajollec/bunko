export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { kavitaIndexStatus } from '@/lib/kavita-index';
export const GET = route(() => json(kavitaIndexStatus()));
