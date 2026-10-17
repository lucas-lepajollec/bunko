import { afterAll, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-root-race-'));
// Run the actual store code in independent workers/connections, outside Vitest's module loader.
for (const name of ['env', 'errors', 'media-root-store']) {
  const source = readFileSync(path.resolve('src/lib', name + '.ts'), 'utf8')
    .replace("from './env'", "from './env.mjs'")
    .replace("from './errors'", "from './errors.mjs'");
  writeFileSync(
    path.join(dir, name + '.mjs'),
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText,
  );
}
const require = createRequire(import.meta.url);
const nativeModule = require.resolve('better-sqlite3');
const workers: Worker[] = [];
afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
  rmSync(dir, { recursive: true, force: true });
});
it.each(['same', 'parent-first', 'child-first'])(
  'admits only one claim across concurrent SQLite connections (%s)',
  async (mode) => {
    const parent = mkdtempSync(path.join(dir, 'library-'));
    const child = path.join(parent, 'shared');
    mkdirSync(child);
    const filename = path.join(parent, 'accounts.db');
    const db = new Database(filename);
    db.pragma('journal_mode=WAL');
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES(1,'First'),(2,'Second');
    CREATE TABLE account_media_roots(user_id INTEGER,mount TEXT,path TEXT,PRIMARY KEY(user_id,mount));`);
    const barrier = new SharedArrayBuffer(4);
    const requests = [
      mode === 'parent-first' ? parent : child,
      mode === 'child-first' ? parent : child,
    ];
    const outcomes = requests.map((root, i) => {
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const worker = new Worker(
        `
      const { workerData: d, parentPort } = require('node:worker_threads');
      process.env.BUNKO_LIBRARY_DIR = d.parent;
      (async () => {
        const { claimMediaRoot } = await import(d.module);
        const Database = require(d.nativeModule);
        const db = new Database(d.filename); db.pragma('busy_timeout=5000');
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(d.barrier),0,0);
        let result;
        try {
          claimMediaRoot(db,d.id,d.root,() => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
          }); result = 'ok';
        } catch (error) { result = error.code || String(error); }
        db.close(); parentPort.postMessage(result);
      })().catch((e) => { throw e; });
    `,
        {
          eval: true,
          workerData: {
            id: i + 1,
            root,
            parent,
            filename,
            barrier,
            nativeModule,
            module: pathToFileURL(path.join(dir, 'media-root-store.mjs')).href,
          },
        },
      );
      workers.push(worker);
      const result = new Promise<string>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (value) => (value === 'ready' ? ready() : resolve(value)));
      });
      return { started, result };
    });
    try {
      await Promise.all(outcomes.map((o) => o.started));
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0);
      expect((await Promise.all(outcomes.map((o) => o.result))).sort()).toEqual([
        'MEDIA_ROOT_TAKEN',
        'ok',
      ]);
      expect(db.prepare('SELECT * FROM account_media_roots').all()).toHaveLength(1);
    } finally {
      db.close();
    }
  },
  15_000,
);
