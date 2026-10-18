import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(os.tmpdir(), 'bunko-profile-'));
process.env.BUNKO_DATA_DIR = directory;
vi.mock('@/lib/kavita-cover', () => ({
  selectedCover: async () => null,
  syncSeriesCover: async () => {},
}));
vi.mock('@/lib/suwayomi', () => ({ chaptersFor: async () => ({ chapters: [], errors: [] }) }));
vi.mock('@/lib/catalog', () => ({
  suwayomiDetail: async () => {
    throw new Error('offline fixture');
  },
}));
vi.mock('@/lib/kavita', () => ({ refreshLibraryProgress: async () => {} }));
vi.mock('@/lib/tracked-sources', async (original) => ({
  ...(await original<object>()),
  drainSourceMatches: async () => {},
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, listTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { sourceServerKey } = await import('@/lib/source-server');
const { persistentSecret } = await import('@/lib/settings');
const { GET } = await import('@/app/api/tracked/route');
const { runUpdateCheck } = await import('@/lib/updates');
const downloads = await import('@/lib/downloads');
const database = db();
function seed(n: number) {
  const namespace = sourceServerKey();
  database.transaction(() => {
    database.exec('DELETE FROM tracked_media;DELETE FROM kavita_series');
    const entry = database.prepare(
      'INSERT INTO tracked_media(id,title,type,created_at,media_json,sources_json,kavita_series_id) VALUES(?,?,?, ?,?,?,?)',
    );
    const observed = database.prepare(
      'INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name,namespace) VALUES(?,?,?,?,?,?)',
    );
    const series = database.prepare('INSERT INTO kavita_series VALUES(?,?)');
    for (let id = 1; id <= n; id++) {
      const media = emptyMedia(`anilist:${id}`, `Fixture ${id}`, 'MANGA');
      const sources = [1, 2, 3].map((s) => ({
        sourceId: String(s),
        sourceName: `Source ${s}`,
        suwayomiMangaId: id * 10 + s,
      }));
      entry.run(
        id,
        media.title,
        'MANGA',
        new Date().toISOString(),
        JSON.stringify(media),
        JSON.stringify(sources),
        id,
      );
      series.run(
        id,
        JSON.stringify({
          seriesId: id,
          libraryId: 1,
          libraryName: 'Manga',
          name: media.title,
          names: [media.title],
          folder: null,
          numbers: Array.from({ length: 20 }, (_, i) => i + 1),
        }),
      );
      for (let c = 1; c <= 50; c++)
        observed.run(id, id * 1000 + c, c, String((c % 3) + 1), 'Source', namespace);
    }
  })();
}
const req = () =>
  new Request('http://bunko.invalid/api/tracked', {
    headers: { Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}` },
  });
afterAll(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
it('profiles the NAS-sized isolated library and guards constant tracked query count', async () => {
  seed(100);
  let queries = 0;
  const prepare = database.prepare.bind(database);
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    for (const method of ['get', 'all', 'run'] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, {
        value: (...args: unknown[]) => {
          queries++;
          return original(...args);
        },
        configurable: true,
      });
    }
    return statement;
  });
  const time = async (action: () => unknown, n: number) => {
    const start = performance.now();
    for (let i = 0; i < n; i++) await action();
    return (performance.now() - start) / n;
  };
  const coldListMs = await time(() => listTracked(), 1);
  const listMs = await time(() => listTracked(), 30);
  queries = 0;
  const apiMs = await time(async () => {
    const r = await GET(req());
    expect(r.status).toBe(200);
    await r.text();
  }, 10);
  const apiQueries = queries / 10;
  const cycleMs = await time(() => runUpdateCheck(downloads.createBatch), 1);
  if (process.env.BUNKO_PROFILE) {
    process.env.BUNKO_WORKER = 'true';
    const cpu = process.cpuUsage();
    const start = performance.now();
    downloads.startWorker();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.env.BUNKO_WORKER = 'false';
    const used = process.cpuUsage(cpu);
    const result = {
      entries: 100,
      sources: 300,
      observed: 5000,
      kavita: 100,
      coldListMs,
      listMs,
      apiMs,
      apiQueries,
      cycleMs,
      idleCpuMsPerMinute:
        (((used.user + used.system) / 1000) * 60000) / (performance.now() - start),
    };
    writeFileSync(
      `/tmp/bunko-perf-${process.env.BUNKO_PROFILE}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } else {
    expect(apiQueries).toBeLessThan(25);
    const coldQueries: number[] = [];
    for (const size of [10, 100]) {
      seed(size);
      queries = 0;
      const response = await GET(req());
      expect((await response.json()).length).toBe(size);
      coldQueries.push(queries);
    }
    expect(coldQueries[1]).toBeLessThanOrEqual(coldQueries[0] + 2);
    expect(coldQueries[1]).toBeLessThan(25);
  }
  spy.mockRestore();
}, 90_000);
