import path from 'node:path';
import { realpathSync, lstatSync, statSync, accessSync, constants } from 'node:fs';
import { db, dataDir } from './db';
import { mkdir, realpath, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { LibraryKind, UnifiedMedia } from '@/types/shared';
import { getSettings } from './settings';
import { AppError } from './errors';
import { suggestedLibraryKind } from './library-kinds';
import { resolveMediaRoot } from './media-root';
/** One shared decision for targets, imports, scans and sidecars. */
export function libraryRoot() {
  dataDir();
  return resolveMediaRoot();
}
export function inside(root: string, folder: string) {
  const relative = path.relative(root, folder);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function validPath(folder: string) {
  return (
    folder.startsWith('/') &&
    !folder.includes('\\') &&
    !folder.includes('\0') &&
    !folder.split('/').includes('..')
  );
}
function reachable(folder: string) {
  try {
    return (
      !lstatSync(libraryRoot()).isSymbolicLink() &&
      statSync(folder).isDirectory() &&
      inside(realpathSync(libraryRoot()), realpathSync(folder))
    );
  } catch {
    return false;
  }
}
export function storedLibraries(): import('@/types/shared').KavitaLibrary[] {
  const row = db().prepare("SELECT value FROM worker_state WHERE key='kavita_libraries'").get() as
    { value: string } | undefined;
  const libraries: import('@/types/shared').KavitaLibrary[] = row ? JSON.parse(row.value) : [];
  return libraries.map((l) => {
    const kind = suggestedLibraryKind(l.name, l.type);
    return { ...l, suggestedFor: kind ? [kind] : [] };
  });
}
/** Resolve one library root, using indexed series as evidence rather than a guessed prefix. */
export function resolveLibraryFolder(
  folder: string,
  seriesFolders: string[] = [],
  prefix = getSettings().kavitaLibraryPath,
): string | null {
  if (!validPath(folder) || !validPath(prefix)) return null;
  const base = path.posix.normalize(folder).replace(/\/$/, '') || '/';
  const under = (parent: string, child: string) =>
    child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
  const relatives = seriesFolders
    .filter((f) => validPath(f) && under(base, f) && f !== base)
    .map((f) => path.posix.relative(base, f));
  const confirmed = (candidate: string) =>
    relatives.some((f) => reachable(path.join(candidate, f)));
  const manual = path.posix.normalize(prefix).replace(/\/$/, '') || '/';
  if (manual !== '/library' && under(manual, base)) {
    const local = path.resolve(libraryRoot(), path.posix.relative(manual, base));
    if (reachable(local) && (!relatives.length || confirmed(local))) return local;
  }
  const parts = base.split('/').filter(Boolean);
  const candidates = [
    ...new Set(parts.map((_, i) => path.join(libraryRoot(), ...parts.slice(i)))),
  ].filter(reachable);
  if (relatives.length && confirmed(libraryRoot())) candidates.push(libraryRoot());
  const proven = [...new Set(candidates.filter(confirmed))];
  if (proven.length) return proven.length === 1 ? proven[0] : null;
  return candidates.length === 1 ? candidates[0] : null;
}
export function mapKavitaPath(
  folder: string,
  prefix = getSettings().kavitaLibraryPath,
): string | null {
  if (!validPath(folder)) return null;
  const series = (
    db().prepare('SELECT payload FROM kavita_series').all() as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as { libraryId: number; folder: string | null });
  const roots = storedLibraries()
    .flatMap((l) => l.folders.map((f) => ({ libraryId: l.id, folder: f.path })))
    .filter((r) => folder === r.folder || folder.startsWith(r.folder.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.folder.length - a.folder.length);
  if (roots.length) {
    const root = roots[0];
    const local = resolveLibraryFolder(
      root.folder,
      series
        .filter((s) => s.libraryId === root.libraryId)
        .flatMap((s) => (s.folder ? [s.folder] : [])),
      prefix,
    );
    return local
      ? path.join(/* turbopackIgnore: true */ local, path.posix.relative(root.folder, folder))
      : null;
  }
  return resolveLibraryFolder(folder, [], prefix);
}
export function kavitaPathForLocal(local: string, target: { folder: string; local: string }) {
  if (!inside(target.local, local)) throw new AppError('UNSAFE_PATH', 'Folder escapes target');
  return path.posix.join(target.folder, ...path.relative(target.local, local).split(path.sep));
}
/** Check every ancestor before creating anything, then check realpath again. */
export async function safeLibraryDirectory(folder: string, create = false) {
  const selected = libraryRoot();
  if (!inside(selected, folder))
    throw new AppError('UNSAFE_PATH', 'Folder escapes mounted library');
  if (create) await mkdir(selected, { recursive: true });
  if (lstatSync(selected).isSymbolicLink())
    throw new AppError('UNSAFE_PATH', 'Instance library root must not be a symlink');
  const root = await realpath(/* turbopackIgnore: true */ selected);
  let current = root;
  for (const part of path.relative(selected, folder).split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    if (create)
      await mkdir(next).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    current = await realpath(next);
    if (!inside(root, current)) throw new AppError('UNSAFE_PATH', 'Folder escapes mounted library');
  }
  dataDir();
  if (libraryRoot() !== selected)
    throw new AppError('UNSAFE_PATH', 'Instance library root changed during operation');
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
  return media.format === 'MANHWA' || media.format === 'MANHUA' || media.format === 'COMIC'
    ? media.format
    : 'MANGA';
}
function belongsToLibrary(target: import('@/types/shared').LibraryTarget) {
  const libraries = storedLibraries();
  return (
    !libraries.length ||
    libraries.some(
      (l) =>
        l.id === target.libraryId &&
        l.folders.some(
          (f) =>
            target.folder === f.path || target.folder.startsWith(f.path.replace(/\/$/, '') + '/'),
        ),
    )
  );
}
export function targetFor(media: Pick<UnifiedMedia, 'format' | 'type'>) {
  const settings = getSettings();
  const kind = libraryKind(media);
  const libraries = storedLibraries();
  const saved = settings.libraryTargets[kind];
  const candidates =
    saved === null
      ? []
      : saved
        ? [saved]
        : libraries
            .filter((l) => l.suggestedFor.includes(kind))
            .flatMap((l) => l.folders.map((f) => ({ libraryId: l.id, folder: f.path })));
  const resolved = candidates.flatMap((t) => {
    if (!belongsToLibrary(t)) return [];
    const local = mapKavitaPath(t.folder);
    if (!local || !reachable(local)) return [];
    try {
      accessSync(local, constants.W_OK);
    } catch {
      return [];
    }
    return [{ ...t, local }];
  });
  if (resolved.length !== 1)
    throw new AppError(
      'TARGET_NOT_CONFIGURED',
      'No unambiguous reachable library target is configured',
      409,
    );
  return resolved[0];
}
export function validateLibraryTargets(
  targets: import('@/types/shared').LibraryTargets,
  prefix: string,
) {
  for (const target of Object.values(targets))
    if (target && (!belongsToLibrary(target) || !mapKavitaPath(target.folder, prefix)))
      throw new AppError(
        'INVALID_LIBRARY_TARGET',
        'Target is outside the reachable mounted Kavita library',
      );
}
