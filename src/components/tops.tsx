'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Star, X } from 'lucide-react';
import type { Ranking, TrackedMedia } from '@/types/shared';
import { KIND_IDS, kindOfMedia, type Kind } from '@/domain/kinds';
import { formatRating } from '@/domain/library-mark';
import { rankedKinds, rankingWorks, type RankedWork } from '@/domain/rankings';
import { send, useApi } from '@/lib/client/api';
import { useViewState } from '@/lib/client/view-state';
import { useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { MediaLink } from './media-link';
import { Select } from './select';
import { toast } from './notify';
import {
  Cover,
  Empty,
  SectionHeading,
  cx,
  errorText,
  field,
  primaryButton,
  smallButton,
} from './ui';

const SHOWN = 10;
type View = Pick<Ranking, 'kind' | 'mode' | 'order' | 'size'> & {
  key: string;
  id: number | null;
  name: string | null;
  builtin: Kind | null;
};

/**
 * Rankings on the profile: one automatic ranking per kind (built from the ratings), plus the
 * user's own — automatic (a kind or every kind, top N) or hand-made. Equal scores can be put in
 * the user's order; a hand-made order against the ratings is flagged.
 */
export function Tops({ entries }: { entries: TrackedMedia[] }) {
  const { t, n } = useI18n();
  const universe = useUniverse();
  const rankings = useApi<Ranking[]>('/api/rankings');
  const saved = useMemo(() => rankings.data ?? [], [rankings.data]);
  const views: View[] = useMemo(() => {
    const builtins = rankedKinds(entries, universe.order).map((k) => {
      const row = saved.find((r) => r.builtin && r.kind === k);
      return {
        key: `kind:${k}`,
        id: row?.id ?? null,
        name: null,
        builtin: k,
        kind: k,
        mode: 'auto' as const,
        size: null,
        order: row?.order ?? [],
      };
    });
    const own = saved
      .filter((r) => !r.builtin)
      .map((r) => ({ ...r, key: `own:${r.id}`, builtin: null }));
    return [...builtins, ...own];
  }, [entries, saved, universe.order]);
  const [chosen, setChosen] = useViewState<string>('top', '');
  // Opens on the kind with the most rated works.
  const largest = [...views]
    .filter((v) => v.builtin)
    .sort((a, b) => rankingWorks(b, entries).length - rankingWorks(a, entries).length)[0];
  const view = views.find((v) => v.key === chosen) ?? largest ?? views[0];
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const works = view ? rankingWorks(view, entries) : [];
  const title = (v: View) =>
    v.builtin ? t('tops.kindTitle', { kind: t(`kind.${v.builtin}`) }) : (v.name ?? '');

  async function save(next: number[]) {
    if (!view) return;
    // Shown at once; the server keeps it.
    void rankings.mutate(
      (list) => {
        const rows = list ?? [];
        if (view.builtin && !view.id)
          return [
            ...rows,
            {
              id: -1,
              name: null,
              kind: view.builtin,
              mode: 'auto',
              size: null,
              order: next,
              builtin: true,
            },
          ];
        return rows.map((r) => (r.id === view.id ? { ...r, order: next } : r));
      },
      { revalidate: false },
    );
    try {
      const fresh = await send<Ranking[]>(
        '/api/rankings',
        'PATCH',
        view.builtin ? { builtin: view.builtin, order: next } : { id: view.id, order: next },
      );
      void rankings.mutate(fresh, { revalidate: false });
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
      void rankings.mutate();
    }
  }
  const ids = works.map((w) => w.entry.id);
  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void save(next);
  };
  const remove = (id: number) => void save(ids.filter((x) => x !== id));
  const add = (id: number) => void save([...ids.filter((x) => x !== id), id]);

  return (
    <section id="tops" className="scroll-mt-28 flex flex-col gap-5">
      <SectionHeading title={t('tops.title')} aside={t('tops.aside')} />
      <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:px-0">
        {views.map((v) => (
          <button
            key={v.key}
            type="button"
            aria-pressed={view?.key === v.key}
            onClick={() => {
              setChosen(v.key);
              setEditing(false);
              setAll(false);
            }}
            className={cx(
              'h-[34px] shrink-0 rounded-full px-3.5',
              view?.key === v.key ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
            )}
          >
            {title(v)}
            <span className="text-muted ml-1.5 font-serif italic">
              {n(rankingWorks(v, entries).length)}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="text-mid flex h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3.5 ring-1 ring-white/15 hover:text-white"
        >
          <Plus className="size-4" aria-hidden />
          {t('tops.new')}
        </button>
      </div>
      {!view ? (
        <Empty title={t('tops.empty')}>{t('tops.emptyBody')}</Empty>
      ) : (
        <>
          <div className="text-mid flex flex-wrap items-center gap-2 text-sm">
            <span>
              {view.mode === 'auto' ? t('tops.autoHint') : t('tops.manualHint')}
              {view.size ? ` · ${t('tops.topN', { n: n(view.size) })}` : ''}
            </span>
            <button
              type="button"
              aria-pressed={editing}
              onClick={() => setEditing(!editing)}
              className={cx(smallButton, 'ml-auto', editing && 'bg-fg text-bg hover:bg-fg')}
            >
              {editing ? t('tops.done') : t('tops.edit')}
            </button>
            {!view.builtin && view.id && (
              <button
                type="button"
                className={smallButton}
                onClick={async () => {
                  if (!window.confirm(t('tops.deleteConfirm', { name: title(view) }))) return;
                  try {
                    await rankings.mutate(
                      await send<Ranking[]>('/api/rankings', 'DELETE', { id: view.id }),
                      { revalidate: false },
                    );
                    setChosen('');
                  } catch (e) {
                    toast({ tone: 'bad', text: errorText(t, e) });
                  }
                }}
              >
                {t('tops.delete')}
              </button>
            )}
          </div>
          {editing && view.mode === 'auto' && (
            <p className="text-muted text-xs">{t('tops.tieHint')}</p>
          )}
          {!works.length && (
            <Empty title={t(view.mode === 'manual' ? 'tops.manualEmpty' : 'tops.empty')} />
          )}
          <ol className="grid gap-x-8 gap-y-1 md:grid-cols-2">
            {(all || editing ? works : works.slice(0, SHOWN)).map((w, i) => (
              <RankRow
                key={w.entry.id}
                work={w}
                editing={editing}
                canUp={view.mode === 'manual' ? i > 0 : w.tiedAbove}
                canDown={view.mode === 'manual' ? i < works.length - 1 : w.tiedBelow}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={view.mode === 'manual' ? () => remove(w.entry.id) : undefined}
              />
            ))}
          </ol>
          {!editing && works.length > SHOWN && (
            <button
              type="button"
              className={cx(smallButton, 'self-start')}
              onClick={() => setAll(!all)}
            >
              {all ? t('tops.less') : t('tops.all', { count: n(works.length) })}
            </button>
          )}
          {editing && view.mode === 'manual' && (
            <AddWork
              entries={entries.filter(
                (e) =>
                  !e.partOf &&
                  !ids.includes(e.id) &&
                  (!view.kind || kindOfMedia(e.media) === view.kind),
              )}
              onAdd={add}
            />
          )}
        </>
      )}
      <CreateRanking
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await rankings.mutate();
          setChosen(`own:${id}`);
          setEditing(true);
        }}
      />
    </section>
  );
}

function RankRow({
  work: w,
  editing,
  canUp,
  canDown,
  onUp,
  onDown,
  onRemove,
}: {
  work: RankedWork;
  editing: boolean;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove?: () => void;
}) {
  const { t, n, locale } = useI18n();
  const e = w.entry;
  const control =
    'text-mid flex size-9 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white disabled:opacity-25';
  return (
    <li className="flex items-center gap-2 rounded-2xl px-2 py-2 hover:bg-white/[0.04]">
      <MediaLink media={e.media} className="flex min-w-0 flex-1 items-center gap-4">
        <span className="font-display w-10 shrink-0 text-right text-3xl font-extrabold tracking-[-0.05em] text-white/80 tabular-nums">
          {n(w.rank)}
        </span>
        <Cover
          src={e.coverUrl ?? e.media.coverUrl}
          fallbacks={e.coverFallbacks}
          className="w-12 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{e.title}</span>
          {w.conflict && (
            <span className="text-warn flex items-center gap-1 text-xs">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {t('tops.conflict', {
                  title: w.conflict.title,
                  rating: formatRating(w.conflict.rating!, locale),
                })}
              </span>
            </span>
          )}
        </span>
        {e.rating != null && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#f5c518] px-2.5 py-1 text-sm font-bold text-black">
            <Star className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden />
            {formatRating(e.rating, locale)}
          </span>
        )}
      </MediaLink>
      {editing && (
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={!canUp}
            onClick={onUp}
            aria-label={t('tops.up')}
            className={control}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            disabled={!canDown}
            onClick={onDown}
            aria-label={t('tops.down')}
            className={control}
          >
            <ArrowDown className="size-4" aria-hidden />
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('tops.remove')}
              className={control}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/** Adds one of the library's works to a hand-made ranking (filtered by typing). */
function AddWork({ entries, onAdd }: { entries: TrackedMedia[]; onAdd: (id: number) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const fold = (v: string) => v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const found = q.trim()
    ? entries.filter((e) => fold(e.title).includes(fold(q.trim()))).slice(0, 8)
    : [];
  return (
    <div className="flex max-w-xl flex-col gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('tops.addPlaceholder')}
        aria-label={t('tops.add')}
        className={field}
      />
      {found.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => {
            onAdd(e.id);
            setQ('');
          }}
          className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]"
        >
          <Cover
            src={e.coverUrl ?? e.media.coverUrl}
            fallbacks={e.coverFallbacks}
            className="w-8 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{e.title}</span>
          <Plus className="text-mid size-4 shrink-0" aria-hidden />
        </button>
      ))}
    </div>
  );
}

function CreateRanking({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { t, n } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [mode, setMode] = useState<'auto' | 'manual'>('manual');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[440px] -translate-y-1/2 flex-col gap-4 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] leading-none font-extrabold tracking-[-0.03em]">
            {t('tops.new')}
          </Dialog.Title>
          <Dialog.Description className="text-muted text-sm">
            {t('tops.newHint')}
          </Dialog.Description>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tops.namePlaceholder')}
            aria-label={t('tops.name')}
            maxLength={80}
            className={field}
          />
          <div className="grid grid-cols-2 gap-2">
            <Select
              label={t('tops.mode')}
              value={mode}
              onChange={(v) => setMode(v as 'auto' | 'manual')}
              options={[
                { value: 'manual', label: t('tops.modeManual') },
                { value: 'auto', label: t('tops.modeAuto') },
              ]}
            />
            <Select
              label={t('catalog.kind')}
              value={kind}
              onChange={(v) => setKind(v as Kind | '')}
              options={[
                { value: '', label: t('kind.all') },
                ...KIND_IDS.map((k) => ({ value: k, label: t(`kind.${k}`) })),
              ]}
            />
            <Select
              label={t('tops.size')}
              value={size}
              onChange={setSize}
              options={[
                { value: '', label: t('tops.sizeAll') },
                ...[10, 25, 50, 100].map((x) => ({
                  value: String(x),
                  label: t('tops.topN', { n: n(x) }),
                })),
              ]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className={smallButton} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={busy || !name.trim()}
              className={primaryButton}
              onClick={async () => {
                setBusy(true);
                try {
                  const { id } = await send<{ id: number }>('/api/rankings', 'POST', {
                    name: name.trim(),
                    kind: kind || null,
                    mode,
                    size: size ? Number(size) : null,
                  });
                  setName('');
                  onCreated(id);
                } catch (e) {
                  toast({ tone: 'bad', text: errorText(t, e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('tops.create')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
