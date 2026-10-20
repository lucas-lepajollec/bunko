import { createHash } from 'node:crypto';
import { db, statement } from './db';
import { getSettings } from './settings';
import type { DownloadChapter } from '@/types/shared';
function namespace() {
  const s = getSettings();
  return createHash('sha256')
    .update(JSON.stringify([s.suwayomiUrl, s.suwayomiUsername, s.suwayomiPassword]))
    .digest('hex');
}
/** Keep source labels from chapter selection available before the first transfer. */
export function saveChapterLabels(
  chapters: Pick<DownloadChapter, 'id' | 'name' | 'number' | 'sourceName'>[],
) {
  const server = namespace();
  db().transaction(() => {
    const save = statement(
      `INSERT INTO chapter_labels(namespace,chapter_id,payload,at) VALUES(?,?,?,?)
       ON CONFLICT(namespace,chapter_id) DO UPDATE SET payload=excluded.payload,at=excluded.at
       WHERE chapter_labels.payload IS NOT excluded.payload`,
    );
    const at = Date.now();
    for (const c of chapters)
      save.run(
        server,
        c.id,
        JSON.stringify({
          id: c.id,
          name: c.name.slice(0, 500),
          number: c.number,
          sourceName: c.sourceName.slice(0, 200),
        }),
        at,
      );
    statement(
      'DELETE FROM chapter_labels WHERE rowid IN (SELECT rowid FROM chapter_labels ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 20000)',
    ).run();
  })();
}
export function chapterLabels(ids: number[]) {
  if (!ids.length)
    return new Map<number, Pick<DownloadChapter, 'id' | 'name' | 'number' | 'sourceName'>>();
  const rows = db()
    .prepare(
      `SELECT chapter_id,payload FROM chapter_labels WHERE namespace=? AND chapter_id IN (${ids
        .slice(0, 500)
        .map(() => '?')
        .join(',')})`,
    )
    .all(namespace(), ...ids.slice(0, 500)) as { chapter_id: number; payload: string }[];
  return new Map(
    rows.map((r) => [
      r.chapter_id,
      JSON.parse(r.payload) as Pick<DownloadChapter, 'id' | 'name' | 'number' | 'sourceName'>,
    ]),
  );
}
