import { sourceCall } from './source-gate';
import { z } from 'zod';
import type { SourceFilter } from '@/types/shared';
import { graphql, sourceInfo } from './suwayomi';
import { AppError } from './errors';
const sort = z.object({ index: z.number().int().nonnegative(), ascending: z.boolean() });
const rawFilter = z.object({
  __typename: z.string(),
  name: z.string(),
  values: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  filters: z.array(z.unknown()).optional(),
});
export function mapFilters(input: unknown[], depth = 0): SourceFilter[] {
  if (depth > 8)
    throw new AppError('SUWAYOMI_FILTER_ERROR', 'Source filters are too deeply nested', 502);
  return input.map((item, position): SourceFilter => {
    const r = rawFilter.parse(item);
    const base = { position, name: r.name };
    switch (r.__typename) {
      case 'HeaderFilter':
        return { ...base, kind: 'header' };
      case 'SeparatorFilter':
        return { ...base, kind: 'separator' };
      case 'SelectFilter':
        return {
          ...base,
          kind: 'select',
          values: z.array(z.string()).parse(r.values),
          default: z.number().int().parse(r.default),
        };
      case 'TextFilter':
        return { ...base, kind: 'text', default: z.string().parse(r.default) };
      case 'CheckBoxFilter':
        return { ...base, kind: 'checkbox', default: z.boolean().parse(r.default) };
      case 'TriStateFilter':
        return {
          ...base,
          kind: 'tristate',
          default: z.enum(['IGNORE', 'INCLUDE', 'EXCLUDE']).parse(r.default),
        };
      case 'SortFilter':
        return {
          ...base,
          kind: 'sort',
          values: z.array(z.string()).parse(r.values),
          default: sort.nullable().parse(r.default),
        };
      case 'GroupFilter':
        return {
          ...base,
          kind: 'group',
          filters: mapFilters(z.array(z.unknown()).parse(r.filters), depth + 1),
        };
      default:
        throw new AppError('SUWAYOMI_FILTER_ERROR', 'Unknown source filter type', 502);
    }
  });
}
function filterFields(depth: number): string {
  // Alias defaults: GraphQL otherwise rejects incompatible scalar fields across union fragments.
  return `__typename
    ... on HeaderFilter { name }
    ... on SeparatorFilter { name }
    ... on SelectFilter { name values selectDefault: default }
    ... on TextFilter { name textDefault: default }
    ... on CheckBoxFilter { name checkboxDefault: default }
    ... on TriStateFilter { name tristateDefault: default }
    ... on SortFilter { name values sortDefault: default { index ascending } }
    ${depth > 0 ? `... on GroupFilter { name filters { ${filterFields(depth - 1)} } }` : '... on GroupFilter { name }'}`;
}
function normalizeDefaults(items: Record<string, unknown>[]): unknown[] {
  return items.map((r) => ({
    ...r,
    default:
      r.selectDefault ??
      r.textDefault ??
      r.checkboxDefault ??
      r.tristateDefault ??
      r.sortDefault ??
      null,
    ...(Array.isArray(r.filters) ? { filters: normalizeDefaults(r.filters) } : {}),
  }));
}
export async function sourceFilters(id: string, signal?: AbortSignal): Promise<SourceFilter[]> {
  await sourceInfo(id, signal);
  const result = await sourceCall(
    () =>
      graphql<{ source: { filters: Record<string, unknown>[] } }>(
        `query($id: LongString!) { source(id:$id) { filters { ${filterFields(8)} } } }`,
        { id },
        10_000,
        signal,
      ),
    signal,
  );
  return mapFilters(normalizeDefaults(result.source.filters));
}
