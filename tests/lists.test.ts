import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { WorkList } from '@/types/shared';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-lists-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, closeTenant, migrateV28, migrateV29, migrateV30 } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const listsRoute = await import('@/app/api/lists/route');
const listRoute = await import('@/app/api/lists/[id]/route');
const trackedRoute = await import('@/app/api/tracked/route');
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

function request(method: string, body: unknown, url: string) {
  return new Request(`http://fixture.test${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
  });
}
const work = (i: number) =>
  track({ media: emptyMedia(`anilist:${70_000 + i}`, `Work ${i}`, 'ANIME'), status: 'COMPLETED' });
const lists = async () =>
  (await (await listsRoute.GET(request('GET', undefined, '/api/lists'))).json()) as WorkList[];
const order = (l: WorkList | undefined) => l?.items.map((i) => i.trackedId);

it('keeps the favorites list in step with the like, whatever path sets it', async () => {
  const [a, b, c] = [work(1), work(2), work(3)];
  await trackedRoute.PATCH(request('PATCH', { id: b.id, favorite: true }, '/api/tracked'));
  await trackedRoute.PATCH(request('PATCH', { id: a.id, favorite: true }, '/api/tracked'));
  let favorites = (await lists()).find((l) => l.system === 'favorites');
  expect(order(favorites)).toEqual([b.id, a.id]);
  // Adding through the list sets the like; reordering keeps it.
  await listRoute.PATCH(request('PATCH', { add: [c.id], at: 0 }, `/api/lists/${favorites!.id}`));
  expect(
    (
      db().prepare('SELECT favorite FROM tracked_media WHERE id=?').get(c.id) as {
        favorite: number;
      }
    ).favorite,
  ).toBe(1);
  favorites = (await lists()).find((l) => l.system === 'favorites');
  expect(order(favorites)).toEqual([c.id, b.id, a.id]);
  // Unliking removes it; the system list cannot be deleted.
  await trackedRoute.PATCH(request('PATCH', { id: b.id, favorite: false }, '/api/tracked'));
  expect(order((await lists()).find((l) => l.system === 'favorites'))).toEqual([c.id, a.id]);
  expect(
    (await listRoute.DELETE(request('DELETE', undefined, `/api/lists/${favorites!.id}`))).status,
  ).toBe(403);
});

it('creates, fills, orders, annotates and deletes a list', async () => {
  const [a, b, c] = [work(11), work(12), work(13)];
  const created = await listsRoute.POST(
    request(
      'POST',
      { name: 'Best isekai', kind: 'anime', ranked: true, add: [a.id, b.id] },
      '/api/lists',
    ),
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: number };
  // Placed at a position; unknown works are ignored; present works move.
  let saved = (await (
    await listRoute.PATCH(request('PATCH', { add: [c.id, 999_999], at: 1 }, `/api/lists/${id}`))
  ).json()) as WorkList[];
  expect(order(saved.find((l) => l.id === id))).toEqual([a.id, c.id, b.id]);
  saved = (await (
    await listRoute.PATCH(
      request(
        'PATCH',
        { order: [b.id, a.id], items: [{ trackedId: a.id, note: 'pour rire' }] },
        `/api/lists/${id}`,
      ),
    )
  ).json()) as WorkList[];
  const list = saved.find((l) => l.id === id)!;
  expect(order(list)).toEqual([b.id, a.id, c.id]);
  expect(list.items[1]).toMatchObject({ note: 'pour rire', tier: null });
  // A list has no tiers; the favorites can be shown as a grid.
  expect(
    (
      await listRoute.PATCH(
        request('PATCH', { items: [{ trackedId: a.id, tier: 'S' }] }, `/api/lists/${id}`),
      )
    ).status,
  ).toBe(400);
  const favorites = (await lists()).find((l) => l.system === 'favorites')!;
  expect(
    (await listRoute.PATCH(request('PATCH', { layout: 'grid' }, `/api/lists/${favorites.id}`)))
      .status,
  ).toBe(200);
  await listRoute.PATCH(request('PATCH', { remove: [b.id] }, `/api/lists/${id}`));
  expect(order((await lists()).find((l) => l.id === id))).toEqual([a.id, c.id]);
  // A removed work leaves every list.
  db().prepare('DELETE FROM tracked_media WHERE id=?').run(a.id);
  expect(order((await lists()).find((l) => l.id === id))).toEqual([c.id]);
  await listRoute.DELETE(request('DELETE', undefined, `/api/lists/${id}`));
  expect((await lists()).some((l) => l.id === id)).toBe(false);
});

it('turns hand-made rankings and likes into lists once', () => {
  const memory = new Database(':memory:');
  memory.exec(`CREATE TABLE tracked_media(id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, favorite INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tracked_media VALUES(1,'B','2026-01-02',1),(2,'A','2026-01-01',1),(3,'C','2026-01-03',0);
    CREATE TABLE rankings(id INTEGER PRIMARY KEY, name TEXT, kind TEXT, mode TEXT, size INTEGER, created_at TEXT);
    CREATE TABLE ranking_items(ranking_id INTEGER, tracked_id INTEGER, position INTEGER);
    INSERT INTO rankings VALUES(1,'Mine','anime','manual',NULL,'2026-02-01'),(2,NULL,'anime','auto',NULL,'2026-02-01');
    INSERT INTO ranking_items VALUES(1,3,0),(1,1,1),(2,1,0);
    PRAGMA user_version=27;`);
  migrateV28(memory);
  migrateV28(memory);
  const rows = memory
    .prepare(
      'SELECT l.name,l.system,i.tracked_id FROM lists l JOIN list_items i ON i.list_id=l.id ORDER BY l.id,i.position',
    )
    .all();
  expect(rows).toEqual([
    { name: '', system: 'favorites', tracked_id: 2 },
    { name: '', system: 'favorites', tracked_id: 1 },
    { name: 'Mine', system: null, tracked_id: 3 },
    { name: 'Mine', system: null, tracked_id: 1 },
  ]);
  expect(memory.prepare('SELECT id FROM rankings').all()).toEqual([{ id: 2 }]);
  // The like keeps the favorites in step from then on.
  memory.exec('UPDATE tracked_media SET favorite=1 WHERE id=3');
  expect(
    memory
      .prepare(
        "SELECT tracked_id FROM list_items WHERE list_id=(SELECT id FROM lists WHERE system='favorites') ORDER BY position",
      )
      .all(),
  ).toEqual([{ tracked_id: 2 }, { tracked_id: 1 }, { tracked_id: 3 }]);
  // Lists shown as tiers become tier lists with S–D rows; the favorites go back to a list.
  memory.exec("UPDATE lists SET layout='tiers'; UPDATE list_items SET tier='A' WHERE tracked_id=3");
  migrateV29(memory);
  migrateV30(memory);
  migrateV30(memory);
  expect(memory.prepare('SELECT system,layout FROM lists ORDER BY id').all()).toEqual([
    { system: 'favorites', layout: 'list' },
    { system: null, layout: 'tiers' },
  ]);
  expect(memory.prepare('SELECT count(*) AS n FROM list_tiers').get()).toEqual({ n: 5 });
  memory.exec("UPDATE list_items SET tier='custom-row' WHERE tracked_id=1");
  expect(memory.prepare("SELECT count(*) AS n FROM list_items WHERE tier='A'").get()).toEqual({
    n: 2,
  });
  memory.close();
});

it('places works by duels with a binary insertion', async () => {
  const { answerDuel, duelQuestion, duelQuestions, startDuel } = await import('@/domain/duel');
  // The user's true preference: smaller first.
  const run = (sorted: number[], pending: number[]) => {
    let state = startDuel(sorted, pending);
    let q = duelQuestion(state);
    while (q) {
      state = answerDuel(state, q.candidate < q.against ? 'candidate' : 'against');
      q = duelQuestion(state);
    }
    return state;
  };
  const sorted = Array.from({ length: 100 }, (_, i) => i * 2);
  const placed = run(sorted, [77]);
  expect(placed.sorted.indexOf(77)).toBe(39);
  expect(placed.asked).toBeLessThanOrEqual(7);
  expect(duelQuestions(100, 1)).toBe(7);
  // Ties settled from scratch: a full order.
  expect(run([5], [3, 9, 1, 7]).sorted).toEqual([1, 3, 5, 7, 9]);
  // "The same" goes right after.
  const same = answerDuel(startDuel([10, 20, 30], [25]), 'same');
  expect(same.sorted).toEqual([10, 20, 25, 30]);
});

it("keeps a tier list's own rows: defaults, renamed, added, removed", async () => {
  const [a, b] = [work(21), work(22)];
  const created = await listsRoute.POST(
    request(
      'POST',
      { name: 'Tiers', kind: null, ranked: false, layout: 'tiers', add: [a.id, b.id] },
      '/api/lists',
    ),
  );
  const { id } = (await created.json()) as { id: number };
  const tierList = async () => (await lists()).find((l) => l.id === id)!;
  expect((await tierList()).tiers.map((t) => t.id)).toEqual(['S', 'A', 'B', 'C', 'D']);
  await listRoute.PATCH(
    request(
      'PATCH',
      {
        items: [
          { trackedId: a.id, tier: 'S' },
          { trackedId: b.id, tier: 'D' },
        ],
      },
      `/api/lists/${id}`,
    ),
  );
  // Rows replaced: D removed (its works go back to "to place"), a new row, S renamed.
  await listRoute.PATCH(
    request(
      'PATCH',
      {
        tiers: [
          { id: 'S', label: 'GOAT', color: '#ff7f7f' },
          { id: 'x1', label: 'Meh', color: '#888888' },
        ],
      },
      `/api/lists/${id}`,
    ),
  );
  const now = await tierList();
  expect(now.tiers).toEqual([
    { id: 'S', label: 'GOAT', color: '#ff7f7f' },
    { id: 'x1', label: 'Meh', color: '#888888' },
  ]);
  expect(now.items.map((i) => [i.trackedId, i.tier])).toEqual([
    [a.id, 'S'],
    [b.id, null],
  ]);
  expect(
    (
      await listRoute.PATCH(
        request('PATCH', { items: [{ trackedId: b.id, tier: 'D' }] }, `/api/lists/${id}`),
      )
    ).status,
  ).toBe(400);
  // A tier list stays one.
  expect(
    (await listRoute.PATCH(request('PATCH', { layout: 'list' }, `/api/lists/${id}`))).status,
  ).toBe(400);
});
