import type { ExtensionSection } from '@/types/shared';
import { statement } from './db';

/**
 * The sections video extensions declare through their `extvideo` catalogs (their kinds: names,
 * ids and 18+ flags are the extensions' own, never written in Bunko). Bunko only remembers what
 * they declared (`extension_sections`), so a section exists after a restart or while its
 * extension is briefly unreachable, and works filed under it keep their place. A section goes
 * once no configured extension declares it and no work is filed under it.
 */
interface Row {
  id: string;
  name: string;
  adult: number;
  addons: string;
  position: number;
}
const rows = () =>
  statement(
    'SELECT id,name,adult,addons,position FROM extension_sections ORDER BY position,id',
  ).all() as Row[];
const filedSections = () =>
  new Set(
    (
      statement(
        "SELECT DISTINCT json_extract(media_json,'$.extensionSection.id') AS id FROM tracked_media WHERE json_extract(media_json,'$.extensionSection.id') IS NOT NULL",
      ).all() as { id: string }[]
    ).map((r) => r.id),
  );

/** What one extension declares now (read successfully): its sections, nothing else. */
export function noteExtensionSections(addonId: string, sections: ExtensionSection[]) {
  const declared = new Map(sections.map((s) => [s.id, s]));
  const save = statement(
    `INSERT INTO extension_sections(id,name,adult,addons,position)
       VALUES(@id,@name,@adult,@addons,@position)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, adult=excluded.adult, addons=excluded.addons,
       position=excluded.position
     WHERE extension_sections.name IS NOT excluded.name OR extension_sections.adult IS NOT excluded.adult
       OR extension_sections.addons IS NOT excluded.addons
       OR extension_sections.position IS NOT excluded.position`,
  );
  const known = new Map(rows().map((r) => [r.id, r]));
  for (const [position, s] of sections.entries()) {
    const addons = new Set(JSON.parse(known.get(s.id)?.addons ?? '[]') as string[]);
    addons.add(addonId);
    save.run({
      id: s.id,
      name: s.name,
      adult: Number(s.adult),
      addons: JSON.stringify([...addons].sort()),
      // The extension's own order.
      position,
    });
  }
  // Sections this extension no longer declares.
  for (const r of known.values()) {
    const addons = JSON.parse(r.addons) as string[];
    if (declared.has(r.id) || !addons.includes(addonId)) continue;
    save.run({ ...r, addons: JSON.stringify(addons.filter((a) => a !== addonId)) });
  }
  forgetUnused();
}

/** Extensions removed from the account no longer declare anything. */
export function pruneExtensionSections(configured: string[]) {
  const keep = new Set(configured);
  const update = statement('UPDATE extension_sections SET addons=? WHERE id=?');
  for (const r of rows()) {
    const addons = JSON.parse(r.addons) as string[];
    const left = addons.filter((a) => keep.has(a));
    if (left.length !== addons.length) update.run(JSON.stringify(left), r.id);
  }
  forgetUnused();
}

/** A section no extension declares and no work is filed under is gone. */
function forgetUnused() {
  const filed = filedSections();
  const drop = statement('DELETE FROM extension_sections WHERE id=?');
  for (const r of rows())
    if ((JSON.parse(r.addons) as string[]).length === 0 && !filed.has(r.id)) drop.run(r.id);
}

/** Kept for callers of the in-memory era: sections now live as long as they are declared or used. */
export function resetExtensionSections() {}

/**
 * Sections the 18+ mode shows, as their extensions declare them: 18+ ones only in the full 18+
 * mode, the others everywhere else. Sections only works still use are listed too (their works
 * keep a kind to show under).
 */
export function visibleExtensionSections(adultOnly: boolean): ExtensionSection[] {
  const all = rows();
  // Undeclared sections only stay while a work is filed under them (the last one may be gone).
  const filed = all.some((r) => r.addons === '[]') ? filedSections() : null;
  return all
    .filter((r) => r.addons !== '[]' || filed!.has(r.id))
    .filter((r) => Boolean(r.adult) === adultOnly)
    .map((r) => ({ id: r.id, name: r.name, adult: Boolean(r.adult) }));
}
