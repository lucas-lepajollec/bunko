'use client';
import { useSyncExternalStore } from 'react';
import type { VideoServer } from '@/types/shared';

/**
 * The video server behind the Jellyfin connection (Jellyfin or Emby, same API). Interface texts
 * and logos name the one actually connected.
 */
const listeners = new Set<() => void>();
let current: VideoServer = 'jellyfin';

export function setVideoServer(server: VideoServer | undefined) {
  const next = server === 'emby' ? 'emby' : 'jellyfin';
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useVideoServer = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => 'jellyfin' as VideoServer,
  );
/** A text naming Jellyfin, for the server actually connected. */
export const forVideoServer = (text: string, server: VideoServer) =>
  server === 'emby' ? text.replace(/Jellyfin/g, 'Emby') : text;
