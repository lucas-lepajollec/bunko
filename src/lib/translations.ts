import path from 'node:path';
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { z } from 'zod';
import type {
  TrackedMedia,
  TranslationAction,
  TranslationFile,
  TranslationJob,
  TranslationModels,
  TranslationRequest,
  TranslationState,
} from '@/types/shared';
import { dataDir, db, getTracked } from './db';
import { AppError } from './errors';
import { endpoint } from './http';
import { kavitaJson, scanKavitaFolder } from './kavita-client';
import { matchKavita, requestKavitaSync } from './kavita-index';
import { isTextKind } from './library-kinds';
import {
  inside,
  libraryRoot,
  mapKavitaPath,
  safeLibraryDirectory,
  storedLibraries,
} from './library-paths';
import { getSettings } from './settings';
import { tenantId } from './tenant-context';
import { tenantSignal } from './tenant-lifecycle';
import { wakeWorker } from './worker-events';

/** Formats TraDoc rebuilds in their original format. */
const FORMATS = new Set(['.epub', '.pdf', '.docx', '.txt', '.md']);
const MAX_UPLOAD = 300 * 1024 * 1024;
const POLL_MS = 30_000;
const RETRY_MS = 120_000;
const REMOTE_STATES = new Set(['pending', 'running', 'paused', 'completed', 'failed']);
/** States the worker still has to act on. */
const ACTIVE: TranslationState[] = ['queued', 'pending', 'running', 'importing'];

interface Row {
  id: number;
  tracked_id: number;
  kavita_path: string;
  file_name: string;
  source_lang: string;
  target_lang: string;
  provider: string | null;
  model: string | null;
  mode: 'replace' | 'separate';
  state: TranslationState;
  progress: number | null;
  error: string | null;
  remote_id: string | null;
  output_path: string | null;
  backup_path: string | null;
  next_check_at: number;
  created_at: string;
  updated_at: string;
}

const remoteSchema = z
  .object({
    id: z.string().min(1).max(100),
    status: z.string(),
    progress: z.object({ percent: z.number() }).partial().optional(),
    external_ref: z.string().nullable().optional(),
  })
  .passthrough();

function config() {
  const s = getSettings();
  if (!s.tradocUrl || !s.tradocApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'TraDoc is not configured', 409);
  return { url: s.tradocUrl.replace(/\/+$/, ''), key: s.tradocApiKey };
}

/** One authenticated TraDoc call; upstream bodies and keys never reach logs or responses. */
async function tradoc(suffix: string, init: RequestInit = {}, timeoutMs = 20_000) {
  const c = config();
  const signal = AbortSignal.any([
    tenantSignal(),
    AbortSignal.timeout(timeoutMs),
    ...(init.signal ? [init.signal] : []),
  ]);
  let response: Response;
  try {
    response = await fetch(endpoint(c.url, suffix), {
      ...init,
      signal,
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${c.key}`, ...init.headers },
    });
  } catch {
    throw new AppError(
      signal.aborted ? 'TRADOC_TIMEOUT' : 'TRADOC_UNREACHABLE',
      'TraDoc could not be reached',
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new AppError('TRADOC_UNAUTHORIZED', 'TraDoc rejected the connection key', 502);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new AppError('TRADOC_NOT_FOUND', 'TraDoc translation not found', 404);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('TRADOC_ERROR', `TraDoc returned HTTP ${response.status}`, 502);
  }
  return response;
}
const tradocJson = async (suffix: string, init?: RequestInit, timeoutMs?: number) =>
  (await tradoc(suffix, init, timeoutMs)).json() as Promise<unknown>;

export async function tradocInfo(signal?: AbortSignal) {
  return z
    .object({
      version: z.string().optional(),
      default: z
        .object({ provider: z.string().nullable(), model: z.string().nullable() })
        .partial()
        .optional(),
    })
    .passthrough()
    .parse(await tradocJson('/info', { signal }, 5000));
}

export async function translationModels(signal?: AbortSignal): Promise<TranslationModels> {
  const [info, catalog] = await Promise.all([
    tradocInfo(signal),
    tradocJson('/models', { signal }, 30_000),
  ]);
  const providers = z
    .object({
      providers: z.array(
        z
          .object({
            provider: z.string().max(100),
            models: z.array(z.string().max(300)).max(2000).default([]),
            error: z.string().max(100).nullable().optional(),
          })
          .passthrough(),
      ),
    })
    .parse(catalog).providers;
  return {
    default: { provider: info.default?.provider ?? null, model: info.default?.model ?? null },
    providers: providers.map((p) => ({
      provider: p.provider,
      models: p.models,
      error: p.error ?? null,
    })),
  };
}

function trackedText(trackedId: number): TrackedMedia {
  const tracked = getTracked(trackedId);
  if (!tracked) throw new AppError('NOT_FOUND', 'Work not found', 404);
  if (!isTextKind(tracked.media))
    throw new AppError('UNSUPPORTED_FORMAT', 'Only books and novels can be translated', 409);
  return tracked;
}

/** Local path of a Kavita file, refusing anything outside this account's media root. */
async function localFile(kavitaPath: string) {
  const local = mapKavitaPath(path.posix.dirname(kavitaPath));
  if (!local) throw new AppError('FILE_UNREACHABLE', 'File is not reachable from Bunko', 409);
  const folder = await safeLibraryDirectory(local);
  const file = path.join(folder, path.posix.basename(kavitaPath));
  const actual = await realpath(file).catch(() => null);
  if (!actual || !inside(await realpath(libraryRoot()), actual) || !(await stat(actual)).isFile())
    throw new AppError('FILE_UNREACHABLE', 'File is not reachable from Bunko', 409);
  return actual;
}

/** The work's translatable files, read live from Kavita (books are not chapter-indexed). */
export async function translatableFiles(
  trackedId: number,
  signal?: AbortSignal,
): Promise<TranslationFile[]> {
  const tracked = trackedText(trackedId);
  const series = matchKavita(tracked.media, tracked.kavitaSeriesId);
  if (!series) return [];
  const volumes = z
    .array(
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
                      z
                        .object({ filePath: z.string(), bytes: z.number().optional() })
                        .passthrough(),
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
    )
    .parse(await kavitaJson(`/api/Series/volumes?seriesId=${series.seriesId}`, { signal }));
  const seen = new Set<string>();
  const files: TranslationFile[] = [];
  for (const v of volumes) {
    const n = Number(v.number ?? v.minNumber);
    const volume = Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
    for (const c of v.chapters ?? [])
      for (const f of c.files ?? []) {
        const kavitaPath = f.filePath.replaceAll('\\', '/');
        if (seen.has(kavitaPath) || !FORMATS.has(path.posix.extname(kavitaPath).toLowerCase()))
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

const view = (r: Row): TranslationJob => ({
  id: r.id,
  trackedId: r.tracked_id,
  fileName: r.file_name,
  sourceLang: r.source_lang,
  targetLang: r.target_lang,
  provider: r.provider,
  model: r.model,
  mode: r.mode,
  state: r.state,
  progress: r.progress,
  error: r.error,
  backup: Boolean(r.backup_path),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const rows = (trackedId?: number) =>
  (trackedId === undefined
    ? db().prepare('SELECT * FROM translation_jobs ORDER BY id DESC').all()
    : db()
        .prepare('SELECT * FROM translation_jobs WHERE tracked_id=? ORDER BY id DESC')
        .all(trackedId)) as Row[];
const row = (id: number) => {
  const r = db().prepare('SELECT * FROM translation_jobs WHERE id=?').get(id) as Row | undefined;
  if (!r) throw new AppError('NOT_FOUND', 'Translation not found', 404);
  return r;
};
function patch(id: number, values: Partial<Omit<Row, 'id'>>) {
  const entries = Object.entries({ ...values, updated_at: new Date().toISOString() });
  db()
    .prepare(`UPDATE translation_jobs SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...entries.map(([, v]) => v), id);
}

export const listTranslations = (trackedId?: number) => rows(trackedId).map(view);

export async function requestTranslations(input: TranslationRequest) {
  config();
  const tracked = trackedText(input.trackedId);
  const files = await translatableFiles(tracked.id);
  const known = new Map(files.map((f) => [f.path, f]));
  const busy = new Set(
    rows(tracked.id)
      .filter((r) => ACTIVE.includes(r.state) || r.state === 'paused')
      .map((r) => r.kavita_path),
  );
  const chosen = [...new Set(input.paths)].map((p) => {
    const file = known.get(p);
    if (!file) throw new AppError('VALIDATION_ERROR', 'File is not one of this work’s files');
    if (busy.has(p))
      throw new AppError('ALREADY_TRANSLATING', 'This file is already being translated', 409);
    return file;
  });
  for (const file of chosen) await localFile(file.path);
  const now = new Date().toISOString();
  const insert = db().prepare(`INSERT INTO translation_jobs(tracked_id,kavita_path,file_name,
    source_lang,target_lang,provider,model,mode,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`);
  db().transaction(() => {
    for (const file of chosen)
      insert.run(
        tracked.id,
        file.path,
        file.name,
        input.sourceLang,
        input.targetLang,
        input.provider ?? null,
        input.model ?? null,
        input.mode,
        now,
        now,
      );
  })();
  wakeWorker();
  return listTranslations(tracked.id);
}

const externalRef = (id: number) => `bunko:${tenantId()}:${id}`;

async function upload(job: Row) {
  // A restart after the upload but before saving its id must not translate the book twice.
  const remote = z
    .array(remoteSchema)
    .parse(await tradocJson('/translations'))
    .find((r) => r.external_ref === externalRef(job.id));
  if (remote) return remote;
  const file = await localFile(job.kavita_path);
  const size = (await stat(file)).size;
  if (size > MAX_UPLOAD) throw new AppError('FILE_TOO_LARGE', 'File is too large', 413);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(await readFile(file))]), job.file_name);
  form.set('source_lang', job.source_lang);
  form.set('target_lang', job.target_lang);
  if (job.provider) form.set('provider', job.provider);
  if (job.model) form.set('model', job.model);
  form.set('external_ref', externalRef(job.id));
  return remoteSchema.parse(
    await tradocJson('/translations', { method: 'POST', body: form }, 10 * 60_000),
  );
}

/** Translated bytes land beside their destination, then replace it atomically. */
async function writeAtomically(destination: string, bytes: Uint8Array, replace: boolean) {
  const temporary = path.join(
    path.dirname(destination),
    `.bunko-translation-${process.pid}-${Date.now()}`,
  );
  const handle = await open(temporary, 'wx', 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (replace) await rename(temporary, destination);
    else await link(temporary, destination);
  } finally {
    if (!replace) await unlink(temporary).catch(() => undefined);
  }
}

const languageTag = (code: string) =>
  code
    .replace(/[^a-z-]/gi, '')
    .toUpperCase()
    .slice(0, 12);

async function install(job: Row) {
  const response = await tradoc(
    `/translations/${encodeURIComponent(job.remote_id!)}/result`,
    {},
    10 * 60_000,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPLOAD)
    throw new AppError('TRADOC_ERROR', 'TraDoc returned an unusable file', 502);
  const original = await localFile(job.kavita_path);
  let output: string;
  let backup: string | null = null;
  if (job.mode === 'replace') {
    // The original leaves the library (Kavita must not index it twice) but stays restorable.
    const folder = path.join(dataDir(), 'translation-backups', String(job.id));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    backup = path.join(folder, path.basename(original));
    await copyFile(original, backup);
    await writeAtomically(original, bytes, true);
    output = original;
  } else {
    // Kavita has no per-file language: the translation becomes its own series beside the original.
    const seriesFolder = path.dirname(original);
    const sibling = `${path.basename(seriesFolder)} [${languageTag(job.target_lang)}]`;
    const folder = await safeLibraryDirectory(path.join(path.dirname(seriesFolder), sibling), true);
    const ext = path.extname(original);
    let candidate = path.join(folder, path.basename(original));
    for (let i = 2; ; i++) {
      try {
        await writeAtomically(candidate, bytes, false);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 50) throw e;
        candidate = path.join(folder, `${path.basename(original, ext)} (${i})${ext}`);
      }
    }
    output = candidate;
  }
  patch(job.id, { output_path: output, backup_path: backup });
  await rescan(output);
}

/** Ask Kavita to rescan the folder that changed; a failed scan never undoes the file. */
async function rescan(localPath: string) {
  try {
    const local = path.dirname(localPath);
    for (const library of storedLibraries())
      for (const folder of library.folders) {
        const mapped = mapKavitaPath(folder.path);
        if (mapped && inside(mapped, local)) {
          await scanKavitaFolder(
            path.posix.join(folder.path, ...path.relative(mapped, local).split(path.sep)),
          );
          requestKavitaSync();
          return;
        }
      }
  } catch {
    /* The periodic index refresh will notice the file. */
  }
}

async function step(job: Row) {
  if (job.state === 'queued') {
    const remote = await upload(job);
    patch(job.id, {
      remote_id: remote.id,
      state: REMOTE_STATES.has(remote.status) ? (remote.status as TranslationState) : 'pending',
      progress: (remote.progress?.percent ?? 0) / 100,
      error: null,
      next_check_at: Date.now() + POLL_MS,
    });
    return;
  }
  if (job.state !== 'importing') {
    const remote = remoteSchema.parse(
      await tradocJson(`/translations/${encodeURIComponent(job.remote_id!)}`),
    );
    const state = REMOTE_STATES.has(remote.status)
      ? (remote.status as TranslationState)
      : 'pending';
    patch(job.id, {
      state: state === 'completed' ? 'importing' : state,
      progress: (remote.progress?.percent ?? 0) / 100,
      error: state === 'failed' ? 'TRADOC_FAILED' : null,
      next_check_at: Date.now() + POLL_MS,
    });
    if (state !== 'completed') return;
  }
  await install(row(job.id));
  patch(job.id, { state: 'completed', progress: 1, error: null });
}

/** Worker pass: uploads queued files, follows TraDoc progress and installs finished books. */
export async function processTranslations(signal: AbortSignal) {
  const settings = getSettings();
  if (!settings.tradocUrl || !settings.tradocApiKey) return;
  const due = rows().filter(
    (r) => ACTIVE.includes(r.state) && (r.state === 'queued' || r.next_check_at <= Date.now()),
  );
  for (const job of due.reverse()) {
    if (signal.aborted) return;
    try {
      await step(job);
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'TRANSLATION_ERROR';
      // Unreachable/timeouts are transient: keep the state and look again later.
      const transient = ['TRADOC_UNREACHABLE', 'TRADOC_TIMEOUT', 'KAVITA_SCAN_ERROR'].includes(
        code,
      );
      patch(job.id, {
        state: transient ? job.state : 'error',
        error: code,
        next_check_at: Date.now() + RETRY_MS,
      });
    }
  }
}

export async function controlTranslation(id: number, action: TranslationAction) {
  const job = row(id);
  const remote = job.remote_id ? `/translations/${encodeURIComponent(job.remote_id)}` : null;
  switch (action) {
    case 'pause':
      if (!remote || !['pending', 'running'].includes(job.state))
        throw new AppError('INVALID_STATE', 'Translation cannot be paused now', 409);
      await tradoc(`${remote}/pause`, { method: 'POST' });
      patch(id, { state: 'paused' });
      break;
    case 'resume':
      if (!remote || !['paused', 'failed'].includes(job.state))
        throw new AppError('INVALID_STATE', 'Translation cannot be resumed now', 409);
      await tradoc(`${remote}/resume`, { method: 'POST' });
      patch(id, { state: 'running', error: null, next_check_at: Date.now() + POLL_MS });
      break;
    case 'retry':
      if (job.state !== 'error')
        throw new AppError('INVALID_STATE', 'Translation has not failed', 409);
      patch(id, {
        state: job.remote_id ? (job.output_path ? 'completed' : 'running') : 'queued',
        error: null,
        next_check_at: 0,
      });
      wakeWorker();
      break;
    case 'cancel':
      if (['completed', 'restored', 'cancelled'].includes(job.state))
        throw new AppError('INVALID_STATE', 'Translation is already finished', 409);
      if (remote && job.state !== 'error')
        await tradoc(`${remote}/pause`, { method: 'POST' }).catch(() => undefined);
      patch(id, { state: 'cancelled' });
      break;
    case 'restore': {
      if (job.state !== 'completed' || !job.backup_path || !job.output_path)
        throw new AppError('INVALID_STATE', 'No original to restore', 409);
      const output = job.output_path;
      const folder = await safeLibraryDirectory(path.dirname(output));
      const target = path.join(folder, path.basename(output));
      await writeAtomically(target, new Uint8Array(await readFile(job.backup_path)), true);
      patch(id, { state: 'restored' });
      await rescan(target);
      break;
    }
    case 'remove':
      // Forgets the job; a kept original is deleted with it (the translation stays in the library).
      if (ACTIVE.includes(job.state) || job.state === 'paused')
        throw new AppError('INVALID_STATE', 'Cancel the translation first', 409);
      if (job.backup_path)
        await rm(path.join(dataDir(), 'translation-backups', String(job.id)), {
          recursive: true,
          force: true,
        });
      db().prepare('DELETE FROM translation_jobs WHERE id=?').run(id);
      return null;
  }
  return view(row(id));
}
