#!/usr/bin/env node
/**
 * Map `[bunko] profile` log lines back to source files. Build the same commit first
 * (`npm run build`), then: docker logs bunko 2>&1 | grep '\[bunko\] profile' | node scripts/perf/map-profile.mjs
 */
import { SourceMap } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('.next/server');
const files = new Map();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.set(entry.name, full);
  }
};
if (!existsSync(root)) throw new Error('Build first: .next/server is missing');
walk(root);
const maps = new Map();
const lookup = (file, line, col) => {
  const full = files.get(file);
  if (!full || !existsSync(`${full}.map`)) return null;
  if (!maps.has(full))
    maps.set(full, new SourceMap(JSON.parse(readFileSync(`${full}.map`, 'utf8'))));
  const entry = maps.get(full).findEntry(line - 1, col - 1);
  if (!entry?.originalSource) return null;
  return `${entry.originalSource.replace(/^.*?\/(src\/)/, '$1')}:${entry.originalLine + 1}${entry.name ? ` (${entry.name})` : ''}`;
};
const input = readFileSync(0, 'utf8');
for (const line of input.split('\n').filter((l) => l.includes('[bunko] profile'))) {
  console.log(line.slice(0, line.indexOf('):') + 2));
  for (const m of line.matchAll(/(\d+)% ([\w.-]+\.js):(\d+):(\d+)/g))
    console.log(
      `  ${m[1].padStart(3)}%  ${lookup(m[2], Number(m[3]), Number(m[4])) ?? `${m[2]}:${m[3]}:${m[4]}`}`,
    );
}
