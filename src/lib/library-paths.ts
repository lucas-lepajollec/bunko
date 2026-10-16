import path from 'node:path';
import { mkdir, realpath, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { LibraryKind, UnifiedMedia } from '@/types/shared';
import { getSettings } from './settings';
import { AppError } from './errors';
import { env } from '@/lib/env';
export const libraryRoot = path.resolve(
  /* turbopackIgnore: true */ env('LIBRARY_DIR') ?? '/library',
);
export function inside(root: string, folder: string) {
  const relative = path.relative(root, folder);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export function mapKavitaPath(
  folder: string,
  prefix = getSettings().kavitaLibraryPath,
): string | null {
  if (
    !folder.startsWith('/') ||
    folder.includes('\\') ||
    folder.includes('\0') ||
    folder.split('/').includes('..')
  )
    return null;
  const base = path.posix.normalize(prefix).replace(/\/+$/, '') || '/';
  const normalized = path.posix.normalize(folder);
  if (normalized !== base && !normalized.startsWith(base === '/' ? '/' : `${base}/`)) return null;
  const local = path.resolve(libraryRoot, path.posix.relative(base, normalized));
  return inside(libraryRoot, local) ? local : null;
}
/** Check every ancestor before creating anything, then check realpath again. */
export async function safeLibraryDirectory(folder: string, create = false) {
  if (!inside(libraryRoot, folder))
    throw new AppError('UNSAFE_PATH', 'Folder escapes mounted library');
  if (create) await mkdir(libraryRoot, { recursive: true });
  const root = await realpath(/* turbopackIgnore: true */ libraryRoot);
  let current = root;
  for (const part of path.relative(libraryRoot, folder).split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    if (create)
      await mkdir(next).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    current = await realpath(next);
    if (!inside(root, current)) throw new AppError('UNSAFE_PATH', 'Folder escapes mounted library');
  }
  return current;
}
export async function writableFolder(folder: string) {
  let probe: string | undefined;
  try {
    const actual = await safeLibraryDirectory(folder);
    probe = path.join(actual, `.bunko-probe-${randomUUID()}`);
    const handle = await open(/* turbopackIgnore: true */ probe, 'wx', 0o600);
    await handle.close();
    await unlink(probe);
    probe = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (probe) await unlink(probe).catch(() => {});
  }
}
export function libraryKind(media: Pick<UnifiedMedia, 'format' | 'type'>): LibraryKind {
  if (media.type === 'NOVEL' || media.format === 'LIGHT_NOVEL' || media.format === 'WEB_NOVEL')
    return 'NOVEL';
  return media.format === 'MANHWA' || media.format === 'MANHUA' ? media.format : 'MANGA';
}
export function targetFor(media: Pick<UnifiedMedia, 'format' | 'type'>) {
  const settings = getSettings();
  const target = settings.libraryTargets[libraryKind(media)];
  const folder = target?.folder ?? settings.kavitaLibraryPath;
  const local = mapKavitaPath(folder);
  if (!local)
    throw new AppError('INVALID_LIBRARY_TARGET', 'Target is outside the mounted Kavita library');
  return { folder, local, libraryId: target?.libraryId ?? null };
}
export function validateLibraryTargets(
  targets: import('@/types/shared').LibraryTargets,
  prefix: string,
) {
  for (const target of Object.values(targets))
    if (target && !mapKavitaPath(target.folder, prefix))
      throw new AppError('INVALID_LIBRARY_TARGET', 'Target is outside the mounted Kavita library');
}
