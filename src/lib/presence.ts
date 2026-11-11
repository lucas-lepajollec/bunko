import { tenantId } from './tenant-context';

/**
 * When an account is being used: any authenticated request (a page, an open tab refreshing).
 * Background work keeps its cadence while someone uses the account and slows down to light
 * upkeep when nobody has for a while, so an idle server stays idle. In memory only: after a
 * restart every account starts idle (due work still runs, at the slower pace).
 */
const IDLE_AFTER_MS = 30 * 60_000;
const scope = globalThis as typeof globalThis & { __bunkoPresence?: Map<number, number> };
const seen = (scope.__bunkoPresence ??= new Map());

export function notePresence(tenant: number) {
  seen.set(tenant, Date.now());
}
/** The current account was used in the last half hour. */
export function inUse(tenant = tenantId()) {
  return Date.now() - (seen.get(tenant) ?? 0) < IDLE_AFTER_MS;
}
/** Any account was used in the last half hour (the worker's own pace). */
export function anyoneInUse() {
  const now = Date.now();
  for (const at of seen.values()) if (now - at < IDLE_AFTER_MS) return true;
  return false;
}
/** A period for periodic work: the usual one in use, a longer one when idle. */
export function cadence(inUseMs: number, idleMs: number, tenant = tenantId()) {
  return inUse(tenant) ? inUseMs : Math.max(inUseMs, idleMs);
}
