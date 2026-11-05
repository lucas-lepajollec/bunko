'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import type { CatalogFilters, DiscoverKind, Season } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { seasonOf } from '@/lib/client/season';
import { Select } from './select';
import { cx } from './ui';
import { tagLabel } from '@/i18n/tags';

export interface FilterValues {
  genre: string;
  tags: string[];
  status: string;
  year: number | null;
  season: Season | '';
  minScore: number | null;
  adultOnly: boolean;
}
const SEASONS: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const SCORES = [60, 70, 80, 90];

export const activeFilterCount = (v: FilterValues) =>
  [v.genre, v.status, v.year, v.season, v.minScore, v.adultOnly].filter(Boolean).length +
  v.tags.length;

/**
 * Always-visible filter row. It offers only what the selected kind can honour (books have no
 * seasons or scores) and 18+ genres, tags and the "18+ only" switch only when the account
 * shows 18+. `onChange` receives URL parameters to set ('' clears one).
 */
export function CatalogFilterBar({
  kind,
  values,
  releasesView,
  onChange,
}: {
  kind: DiscoverKind;
  values: FilterValues;
  /** Latest chapters view: only the genre applies there. */
  releasesView: boolean;
  onChange: (patch: Record<string, string>) => void;
}) {
  const { t, language } = useI18n();
  const filters = useApi<CatalogFilters>(`/api/catalog/filters?kind=${kind}`);
  const f = filters.data;
  const thisYear = seasonOf().year;
  const [tagsOpen, setTagsOpen] = useState(false);
  const genreLabel = (g: string) => (t(`genre.${g}`) === `genre.${g}` ? g : t(`genre.${g}`));
  const count = activeFilterCount(values);
  const control = 'shrink-0';
  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="group"
        aria-label={t('catalog.filters')}
        className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
      >
        <Select
          label={t('catalog.genres')}
          value={values.genre}
          onChange={(v) => onChange({ genre: v })}
          options={[
            { value: '', label: t('catalog.anyGenre') },
            ...(f?.genres ?? [])
              .map((g) => ({ value: g, label: genreLabel(g) }))
              .sort((a, b) => a.label.localeCompare(b.label, language)),
            // 18+ genres apart, at the end, marked as such.
            ...(f?.adultGenres ?? []).map((g) => ({
              value: g,
              label: `${genreLabel(g)} · 18+`,
            })),
          ]}
          className={control}
        />
        {!releasesView && ((f?.tags.length ?? 0) > 0 || f?.keywordSearch) && (
          <button
            type="button"
            onClick={() => setTagsOpen(true)}
            className={cx(
              'h-9 shrink-0 rounded-full px-3.5',
              values.tags.length
                ? 'bg-white/[0.14] text-white'
                : 'text-mid bg-white/[0.06] hover:text-white',
            )}
          >
            {values.tags.length
              ? t('catalog.tagsCount', { n: values.tags.length })
              : t('catalog.tags')}
          </button>
        )}
        {!releasesView && f?.status && (
          <Select
            label={t('catalog.status')}
            value={values.status}
            onChange={(v) => onChange({ status: v })}
            options={[
              { value: '', label: t('catalog.statusAll') },
              { value: 'RELEASING', label: t('status.releasing') },
              { value: 'FINISHED', label: t('status.finished') },
            ]}
            className={control}
          />
        )}
        {!releasesView && f?.year && (
          <Select
            label={t('catalog.year')}
            value={values.year ? String(values.year) : ''}
            onChange={(v) => onChange(v ? { year: v } : { year: '', season: '' })}
            options={[
              { value: '', label: t('catalog.anyYear') },
              ...Array.from({ length: thisYear - 1979 }, (_, i) => String(thisYear - i)).map(
                (y) => ({ value: y, label: y }),
              ),
            ]}
            className={control}
          />
        )}
        {!releasesView && f?.season && (
          <Select
            label={t('catalog.season')}
            value={values.season}
            onChange={(v) =>
              onChange(v && !values.year ? { season: v, year: String(thisYear) } : { season: v })
            }
            options={[
              { value: '', label: t('catalog.anySeason') },
              ...SEASONS.map((x) => ({ value: x, label: t(`season.${x}`) })),
            ]}
            className={control}
          />
        )}
        {!releasesView && f?.score && (
          <Select
            label={t('catalog.minScore')}
            value={values.minScore ? String(values.minScore) : ''}
            onChange={(v) => onChange({ minScore: v })}
            options={[
              { value: '', label: t('catalog.anyScore') },
              ...SCORES.map((s) => ({
                value: String(s),
                label: t('catalog.scoreAtLeast', { n: s }),
              })),
            ]}
            className={control}
          />
        )}
        {!releasesView && f?.adult && (
          <button
            type="button"
            aria-pressed={values.adultOnly}
            onClick={() => onChange({ adultOnly: values.adultOnly ? '' : '1' })}
            className={cx(
              'h-9 shrink-0 rounded-full px-3.5',
              values.adultOnly
                ? 'bg-fg text-bg font-semibold'
                : 'text-mid bg-white/[0.06] hover:text-white',
            )}
          >
            {t('catalog.adultOnly')}
          </button>
        )}
        {count > 0 && (
          <button
            type="button"
            onClick={() =>
              onChange({
                genre: '',
                tags: '',
                status: '',
                year: '',
                season: '',
                minScore: '',
                adultOnly: '',
              })
            }
            className="text-muted h-9 shrink-0 px-2 hover:text-white"
          >
            {t('catalog.clearFilters')}
          </button>
        )}
      </div>
      {!releasesView && values.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-sm">
          {values.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onChange({ tags: values.tags.filter((x) => x !== tag).join(',') })}
              className="flex h-8 items-center gap-1.5 rounded-full bg-white/[0.08] px-3 hover:bg-white/[0.12]"
              aria-label={t('catalog.removeTag', { tag })}
            >
              {tagName(tag, language)}
              <span aria-hidden className="text-muted">
                ✕
              </span>
            </button>
          ))}
        </div>
      )}
      {tagsOpen && f && (
        <TagPicker
          groups={f.tags}
          keywordSearch={f.keywordSearch}
          selected={values.tags}
          onClose={() => setTagsOpen(false)}
          onApply={(tags) => {
            setTagsOpen(false);
            onChange({ tags: tags.join(',') });
          }}
        />
      )}
    </div>
  );
}

/** A tag's label: AniList names are translated; TMDB keywords travel as `id~name`. */
function tagName(tag: string, language: Parameters<typeof tagLabel>[1]) {
  const keyword = /^\d+~(.+)$/.exec(tag);
  return keyword ? keyword[1] : tagLabel(tag, language);
}

function TagPicker({
  groups,
  keywordSearch,
  selected,
  onClose,
  onApply,
}: {
  groups: CatalogFilters['tags'];
  keywordSearch: boolean;
  selected: string[];
  onClose: () => void;
  onApply: (tags: string[]) => void;
}) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>(selected);
  const collator = useMemo(() => new Intl.Collator(language), [language]);
  // Series and films: TMDB keywords, searched as the user types.
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setTyped(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);
  const keywords = useApi<{ value: string; label: string }[]>(
    keywordSearch && typed.length >= 2
      ? `/api/catalog/keywords?q=${encodeURIComponent(typed)}`
      : null,
  );
  // Labels in the interface language where a translation exists, sorted alphabetically.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (keywordSearch)
      return [
        {
          category: 'keywords',
          adult: false,
          tags: [
            // What is already chosen stays visible, then the matches.
            ...picked.map((name) => ({ name, label: tagName(name, language) })),
            ...(keywords.data ?? [])
              .filter((k) => !picked.includes(k.value))
              .map((k) => ({ name: k.value, label: k.label })),
          ],
        },
      ].filter((g) => g.tags.length);
    return groups
      .map((g) => ({
        category: g.category,
        adult: Boolean(g.adult),
        tags: g.names
          .map((name) => ({ name, label: tagLabel(name, language) }))
          .filter(
            (x) => !q || x.label.toLowerCase().includes(q) || x.name.toLowerCase().includes(q),
          )
          .sort((a, b) => collator.compare(a.label, b.label)),
      }))
      .filter((g) => g.tags.length);
  }, [groups, query, language, collator, keywordSearch, keywords.data, picked]);
  const toggle = (name: string) =>
    setPicked((p) =>
      p.includes(name) ? p.filter((x) => x !== name) : p.length >= 10 ? p : [...p, name],
    );
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-3 top-[6dvh] bottom-[6dvh] z-50 mx-auto flex max-w-[960px] flex-col rounded-3xl border outline-none">
          <div className="flex flex-col gap-4 p-5 pb-4 md:p-7 md:pb-5">
            <div className="flex items-start gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <Dialog.Title className="font-display text-[26px] leading-none font-extrabold tracking-[-0.03em]">
                  {t('catalog.tags')}
                </Dialog.Title>
                <Dialog.Description className="text-muted text-sm">
                  {t('catalog.tagsHint')}
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="text-mid -mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08]"
                aria-label={t('common.close')}
              >
                ✕
              </Dialog.Close>
            </div>
            <label className="flex h-12 items-center gap-3 rounded-full bg-white/[0.08] px-4 focus-within:bg-white/[0.12]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
                className="text-muted shrink-0"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={keywordSearch ? t('catalog.keywordsSearch') : t('catalog.tagsSearch')}
                aria-label={t('catalog.tagsSearch')}
                className="placeholder:text-mid min-w-0 flex-1 bg-transparent text-[15px] outline-none"
              />
            </label>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 md:px-7">
            {shown.map((g) => (
              <section key={g.category} className="flex flex-col gap-2">
                <h3
                  className={cx(
                    'text-xs tracking-[0.14em] uppercase',
                    g.adult ? 'text-warn' : 'text-muted',
                  )}
                >
                  {t(`catalog.tagGroup.${g.category}`) === `catalog.tagGroup.${g.category}`
                    ? g.category
                    : t(`catalog.tagGroup.${g.category}`)}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {g.tags.map((tag) => (
                    <button
                      key={tag.name}
                      type="button"
                      aria-pressed={picked.includes(tag.name)}
                      onClick={() => toggle(tag.name)}
                      className={cx(
                        'h-9 rounded-full px-3.5 text-sm',
                        picked.includes(tag.name)
                          ? 'bg-fg text-bg font-semibold'
                          : 'text-mid bg-white/[0.06] hover:text-white',
                      )}
                    >
                      {tag.label}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {!shown.length && (
              <p className="text-muted text-sm">
                {keywordSearch && typed.length < 2
                  ? t('catalog.keywordsHint')
                  : t('catalog.tagsNone')}
              </p>
            )}
          </div>
          <div className="border-line flex items-center gap-3 border-t p-4 md:px-7">
            <span className="text-muted text-sm">
              {t('catalog.tagsPicked', { n: picked.length })}
            </span>
            <button
              type="button"
              onClick={() => setPicked([])}
              className="text-mid ml-auto text-sm hover:text-white"
            >
              {t('common.clear')}
            </button>
            <button
              type="button"
              onClick={() => onApply(picked)}
              className="bg-fg text-bg h-10 rounded-full px-5 text-sm font-semibold"
            >
              {t('catalog.applyTags')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
