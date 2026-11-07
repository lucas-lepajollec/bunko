import type { Ranking } from '@/types/shared';
import { KINDS, type Kind } from '@/domain/kinds';
import { db, statement } from './db';
import { AppError } from './errors';

/**
 * The user's rankings (see migrateV27). The server keeps names, kinds, sizes and orders; which
 * works an automatic ranking holds and how it sorts them is computed where the library is (the
 * same rule everywhere: `src/domain/rankings.ts`).
 */
interface Row {
  id: number;
  name: string | null;
  kind: string | null;
  mode: 'auto' | 'manual';
  size: number | null;
  created_at: string;
}

export function listRankings(): Ranking[] {
  const rows = statement('SELECT * FROM rankings ORDER BY created_at, id').all() as Row[];
  const items = statement(
    'SELECT ranking_id, tracked_id, position FROM ranking_items ORDER BY ranking_id, position',
  ).all() as { ranking_id: number; tracked_id: number; position: number }[];
  const byRanking = new Map<number, number[]>();
  for (const i of items)
    byRanking.set(i.ranking_id, [...(byRanking.get(i.ranking_id) ?? []), i.tracked_id]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind && r.kind in KINDS ? (r.kind as Kind) : null,
    mode: r.mode,
    size: r.size,
    order: byRanking.get(r.id) ?? [],
    builtin: r.name === null,
  }));
}

export function createRanking(input: {
  name: string;
  kind: Kind | null;
  mode: 'auto' | 'manual';
  size: number | null;
}) {
  const id = Number(
    statement('INSERT INTO rankings(name,kind,mode,size,created_at) VALUES(?,?,?,?,?)').run(
      input.name,
      input.kind,
      input.mode,
      input.size,
      new Date().toISOString(),
    ).lastInsertRowid,
  );
  return id;
}

/** The automatic ranking of a kind, created the first time its order of equal scores is set. */
function builtinId(kind: Kind) {
  const row = statement('SELECT id FROM rankings WHERE name IS NULL AND kind=?').get(kind) as
    { id: number } | undefined;
  return (
    row?.id ??
    Number(
      statement(
        "INSERT INTO rankings(name,kind,mode,size,created_at) VALUES(NULL,?,'auto',NULL,?)",
      ).run(kind, new Date().toISOString()).lastInsertRowid,
    )
  );
}

export function updateRanking(input: {
  id?: number;
  builtin?: Kind;
  name?: string;
  kind?: Kind | null;
  size?: number | null;
  order?: number[];
}) {
  db().transaction(() => {
    const id = input.builtin ? builtinId(input.builtin) : input.id;
    const row = statement('SELECT * FROM rankings WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Ranking not found', 404);
    if (row.name !== null) {
      if (input.name !== undefined)
        statement('UPDATE rankings SET name=? WHERE id=?').run(input.name, row.id);
      if (input.kind !== undefined)
        statement('UPDATE rankings SET kind=? WHERE id=?').run(input.kind, row.id);
      if (input.size !== undefined)
        statement('UPDATE rankings SET size=? WHERE id=?').run(input.size, row.id);
    }
    if (input.order) {
      // Only works of this library; the order given replaces the previous one.
      const known = new Set(
        (statement('SELECT id FROM tracked_media').all() as { id: number }[]).map((r) => r.id),
      );
      statement('DELETE FROM ranking_items WHERE ranking_id=?').run(row.id);
      const insert = statement(
        'INSERT OR IGNORE INTO ranking_items(ranking_id,tracked_id,position) VALUES(?,?,?)',
      );
      input.order.filter((t) => known.has(t)).forEach((t, i) => insert.run(row.id, t, i));
    }
  })();
}

export function deleteRanking(id: number) {
  statement('DELETE FROM rankings WHERE id=? AND name IS NOT NULL').run(id);
}
