/**
 * Provider text (synopses, news) arrives as HTML fragments. These helpers turn it into plain
 * text that React then escapes; they are not an HTML sanitizer.
 */

/** Removes tags until none is left, so a nested fragment like `<<b>i>` cannot reassemble one. */
export function stripTags(value: string, replacement = '') {
  let out = value;
  for (let previous = ''; out !== previous;) {
    previous = out;
    out = out.replace(/<[^>]*>/g, replacement);
  }
  return out;
}

/** Decodes the entities providers use. `&amp;` goes last so `&amp;lt;` stays the text `&lt;`. */
export function decodeEntities(value: string) {
  return value
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
