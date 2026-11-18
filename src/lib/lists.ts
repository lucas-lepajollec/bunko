import type { ListLayout, ListTier, WorkList } from '@/types/shared';
import { KINDS, type Kind } from '@/domain/kinds';
import { db, statement } from './db';
import { AppError } from './errors';

/**
 * The user's lists (see migrateV28). The favorites list is the `favorite` flag of the works in
 * the user's order: adding to it or removing from it sets the flag (triggers keep its items).
 */
interface Row {
  id: number;
  name: string;
  description: string;
  kind: string | null;
  ranked: number;
  layout: ListLayout;
  system: 'favorites' | null;
  created_at: string;
  updated_at: string;
}
interface ItemRow {
  list_id: number;
  tracked_id: number;
  tier: ListTier | null;
  note: string;
  added_at: string;
}

export function listLists(): WorkList[] {
  const rows = statement(
    'SELECT * FROM lists ORDER BY system IS NULL, created_at, id',
  ).all() as Row[];
  const items = statement(
    'SELECT list_id,tracked_id,tier,note,added_at FROM list_items ORDER BY list_id, position',
  ).all() as ItemRow[];
  const byList = new Map<number, ItemRow[]>();
  for (const i of items) {
    const at = byList.get(i.list_id);
    if (at) at.push(i);
    else byList.set(i.list_id, [i]);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind && r.kind in KINDS ? (r.kind as Kind) : null,
    ranked: r.ranked === 1,
    layout: r.layout,
    system: r.system,
    items: (byList.get(r.id) ?? []).map((i) => ({
      trackedId: i.tracked_id,
      tier: i.tier,
      note: i.note,
      addedAt: i.added_at,
    })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function createList(input: {
  name: string;
  description?: string;
  kind: Kind | null;
  ranked: boolean;
  layout?: ListLayout;
  add?: number[];
}) {
  return db().transaction(() => {
    const now = new Date().toISOString();
    const id = Number(
      statement(
        'INSERT INTO lists(name,description,kind,ranked,layout,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).run(
        input.name,
        input.description ?? '',
        input.kind,
        Number(input.ranked),
        input.layout ?? 'list',
        now,
        now,
      ).lastInsertRowid,
    );
    if (input.add?.length) addItems(id, input.add);
    return id;
  })();
}

function row(id: number) {
  const r = statement('SELECT * FROM lists WHERE id=?').get(id) as Row | undefined;
  if (!r) throw new AppError('NOT_FOUND', 'List not found', 404);
  return r;
}

function known(ids: readonly number[]) {
  const all = new Set(
    (statement('SELECT id FROM tracked_media').all() as { id: number }[]).map((r) => r.id),
  );
  return ids.filter((t) => all.has(t));
}

/** Writes the list's order (works not given keep their order after the given ones). */
function writeOrder(id: number, order: readonly number[]) {
  const current = (
    statement('SELECT tracked_id FROM list_items WHERE list_id=? ORDER BY position').all(id) as {
      tracked_id: number;
    }[]
  ).map((r) => r.tracked_id);
  const present = new Set(current);
  const given = [...new Set(order)].filter((t) => present.has(t));
  const rest = current.filter((t) => !given.includes(t));
  const update = statement('UPDATE list_items SET position=? WHERE list_id=? AND tracked_id=?');
  [...given, ...rest].forEach((t, i) => update.run(i, id, t));
}

/** Adds works at the end, or from `at` (0-based) on, in the order given; present works move. */
function addItems(id: number, ids: readonly number[], at?: number) {
  const r = row(id);
  const works = known([...new Set(ids)]);
  if (!works.length) return;
  if (r.system === 'favorites') {
    const like = statement('UPDATE tracked_media SET favorite=1 WHERE id=?');
    for (const t of works) like.run(t);
  } else {
    const now = new Date().toISOString();
    const insert = statement(
      `INSERT OR IGNORE INTO list_items(list_id,tracked_id,position,added_at)
       VALUES(?,?,COALESCE((SELECT MAX(position) FROM list_items WHERE list_id=?),-1)+1,?)`,
    );
    for (const t of works) insert.run(id, t, id, now);
  }
  if (at !== undefined) {
    const current = (
      statement('SELECT tracked_id FROM list_items WHERE list_id=? ORDER BY position').all(id) as {
        tracked_id: number;
      }[]
    )
      .map((x) => x.tracked_id)
      .filter((t) => !works.includes(t));
    const index = Math.max(0, Math.min(at, current.length));
    writeOrder(id, [...current.slice(0, index), ...works, ...current.slice(index)]);
  }
}

function removeItems(id: number, ids: readonly number[]) {
  const r = row(id);
  if (r.system === 'favorites') {
    const unlike = statement('UPDATE tracked_media SET favorite=0 WHERE id=?');
    for (const t of ids) unlike.run(t);
  } else {
    const remove = statement('DELETE FROM list_items WHERE list_id=? AND tracked_id=?');
    for (const t of ids) remove.run(id, t);
  }
}

export function updateList(
  id: number,
  input: {
    name?: string;
    description?: string;
    kind?: Kind | null;
    ranked?: boolean;
    layout?: ListLayout;
    order?: number[];
    add?: number[];
    at?: number;
    remove?: number[];
    items?: { trackedId: number; note?: string; tier?: ListTier | null }[];
  },
) {
  db().transaction(() => {
    const r = row(id);
    // The system list keeps its name (it is translated) and stays ranked.
    if (r.system === null) {
      if (input.name !== undefined)
        statement('UPDATE lists SET name=? WHERE id=?').run(input.name, id);
      if (input.ranked !== undefined)
        statement('UPDATE lists SET ranked=? WHERE id=?').run(Number(input.ranked), id);
    }
    if (input.description !== undefined)
      statement('UPDATE lists SET description=? WHERE id=?').run(input.description, id);
    if (input.kind !== undefined)
      statement('UPDATE lists SET kind=? WHERE id=?').run(input.kind, id);
    if (input.layout !== undefined)
      statement('UPDATE lists SET layout=? WHERE id=?').run(input.layout, id);
    if (input.remove?.length) removeItems(id, input.remove);
    if (input.add?.length) addItems(id, input.add, input.at);
    if (input.order) writeOrder(id, input.order);
    if (input.items?.length) {
      const note = statement('UPDATE list_items SET note=? WHERE list_id=? AND tracked_id=?');
      const tier = statement('UPDATE list_items SET tier=? WHERE list_id=? AND tracked_id=?');
      for (const i of input.items) {
        if (i.note !== undefined) note.run(i.note, id, i.trackedId);
        if (i.tier !== undefined) tier.run(i.tier, id, i.trackedId);
      }
    }
    statement('UPDATE lists SET updated_at=? WHERE id=?').run(new Date().toISOString(), id);
  })();
}

export function deleteList(id: number) {
  const r = row(id);
  if (r.system) throw new AppError('FORBIDDEN', 'The favorites list cannot be deleted', 403);
  statement('DELETE FROM lists WHERE id=?').run(id);
}
