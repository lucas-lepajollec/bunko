/** Small bounded XML tree reader for public metadata. No DTD/entity expansion or external IO. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}
export function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (full, key: string) => {
    if (key[0] === '#') {
      const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return (
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[key] ?? full
    );
  });
}
export function parseXml(xml: string): XmlNode {
  if (xml.length > 4_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Invalid metadata XML');
  const root: XmlNode = { name: 'root', attrs: {}, text: '', children: [] };
  const stack = [root];
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.length > 100_000) throw new Error('XML budget exceeded');
  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      parent.text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length < 2 || parent.name !== token.slice(2, -1).trim().split(':').at(-1))
        throw new Error('Invalid XML');
      stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const name = /^<([\w:.-]+)/.exec(token)?.[1];
      if (!name) throw new Error('Invalid XML');
      const attrs = Object.fromEntries(
        [...token.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [m[1], xmlText(m[3])]),
      );
      const node: XmlNode = { name: name.split(':').at(-1)!, attrs, text: '', children: [] };
      parent.children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
      if (stack.length > 32) throw new Error('XML depth exceeded');
    } else parent.text += xmlText(token);
  }
  if (stack.length !== 1) throw new Error('Invalid XML');
  return root;
}
export const nodes = (node: XmlNode, name: string): XmlNode[] =>
  node.children.flatMap((c) => [...(c.name === name ? [c] : []), ...nodes(c, name)]);
export const content = (node: XmlNode): string =>
  [node.text, ...node.children.map(content)].join(' ').replace(/\s+/g, ' ').trim();
export const values = (node: XmlNode, name: string) => nodes(node, name).map(content);
