import path from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from './errors';
import { kavitaJson } from './kavita-client';
import { inside, libraryRoot, mapKavitaPath, safeLibraryDirectory } from './library-paths';

/** One file of a Kavita series (books are not chapter-indexed: Kavita lists them live). */
export interface SeriesFile {
  /** Kavita-side path; identifies the file. */
  path: string;
  name: string;
  volume: number | null;
  sizeBytes: number | null;
}

const volumesSchema = z.array(
  z
    .object({
      number: z.union([z.string(), z.number()]).nullable().optional(),
      minNumber: z.number().optional(),
      chapters: z
        .array(
          z
            .object({
              files: z
                .array(
                  z.object({ filePath: z.string(), bytes: z.number().optional() }).passthrough(),
                )
                .nullable()
                .optional(),
            })
            .passthrough(),
        )
        .nullable()
        .optional(),
    })
    .passthrough(),
);

/** The series' files with one of these extensions, by volume then name. */
export async function seriesFiles(
  seriesId: number,
  formats: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<SeriesFile[]> {
  const volumes = volumesSchema.parse(
    await kavitaJson(`/api/Series/volumes?seriesId=${seriesId}`, { signal }),
  );
  const seen = new Set<string>();
  const files: SeriesFile[] = [];
  for (const v of volumes) {
    const n = Number(v.number ?? v.minNumber);
    const volume = Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
    for (const c of v.chapters ?? [])
      for (const f of c.files ?? []) {
        const kavitaPath = f.filePath.replaceAll('\\', '/');
        if (seen.has(kavitaPath) || !formats.has(path.posix.extname(kavitaPath).toLowerCase()))
          continue;
        seen.add(kavitaPath);
        files.push({
          path: kavitaPath,
          name: path.posix.basename(kavitaPath),
          volume,
          sizeBytes: f.bytes ?? null,
        });
      }
  }
  return files.sort(
    (a, b) =>
      (a.volume ?? Infinity) - (b.volume ?? Infinity) ||
      a.name.localeCompare(b.name, 'en', { numeric: true }),
  );
}

/** Local path of a Kavita file, refusing anything outside this account's media root. */
export async function localKavitaFile(kavitaPath: string) {
  const local = mapKavitaPath(path.posix.dirname(kavitaPath));
  if (!local) throw new AppError('FILE_UNREACHABLE', 'File is not reachable from Bunko', 409);
  const folder = await safeLibraryDirectory(local);
  const file = path.join(folder, path.posix.basename(kavitaPath));
  const actual = await realpath(file).catch(() => null);
  if (!actual || !inside(await realpath(libraryRoot()), actual) || !(await stat(actual)).isFile())
    throw new AppError('FILE_UNREACHABLE', 'File is not reachable from Bunko', 409);
  return actual;
}

/** Fails with a clear code when the container's user cannot read the file (wrong owner). */
export async function assertReadable(file: string, purpose: string) {
  try {
    const handle = await open(file, 'r');
    try {
      await handle.read(Buffer.alloc(1), 0, 1, 0);
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'read error';
    console.warn(
      `[bunko] ${purpose} file not readable by Bunko (uid ${process.getuid?.()}): ${code}`,
    );
    throw new AppError('FILE_UNREADABLE', 'Bunko cannot read this file', 409);
  }
}
