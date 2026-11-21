'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { Suspense, useState } from 'react';
import { ExternalLink, Play, X } from 'lucide-react';
import { KIND_IDS } from '@/domain/kinds';
import type {
  DiscoverKind,
  NewsFeed,
  NewsItem,
  NewsPage,
  NewsType,
  PublicSettings,
} from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useUniverse } from '@/lib/client/universe';
import { useViewState } from '@/lib/client/view-state';
import { useI18n } from '@/i18n/I18nProvider';
import { MediaLink } from '@/components/media-link';
import { ScrollRow } from '@/components/media';
import { LoadNotice } from '@/components/load-notice';
import { Page } from '@/components/shell';
import { SlidingHighlight } from '@/components/sliding-highlight';
import { toast } from '@/components/notify';
import { useRelativeTime } from '@/components/time';
import {
  Cover,
  Empty,
  ErrorNote,
  PageTitle,
  Pill,
  SectionHeading,
  Skeleton,
  cx,
  errorText,
  smallButton,
} from '@/components/ui';

export default function NewsRoute() {
  return (
    <Suspense>
      <News />
    </Suspense>
  );
}

type View = 'all' | 'trailers' | NewsType;
const VIEWS: View[] = ['all', 'trailers', 'upcoming', 'announced', 'edition', 'article'];
/** How many of each section show in the overview before "See all". */
const PREVIEW = 12;

/**
 * News of every kind, or of the one picked: trailers, works coming soon and just announced, new
 * editions, and the articles of the feeds the user follows. Where it comes from is up to each
 * kind: its catalogs, its release sources, its feeds.
 */
function News() {
  const { t } = useI18n();
  const universe = useUniverse();
  const [kind, setKind] = useViewState<DiscoverKind>('kind', universe.active, ['all', ...KIND_IDS]);
  const [view, setView] = useViewState<View>('view', 'all', VIEWS);
  const [trailer, setTrailer] = useState<NewsItem | null>(null);
  const kinds = kind === 'all' ? universe.enabled : [kind];
  const news = useApi<NewsPage>(
    universe.ready
      ? `/api/news?kind=${kind}${kind === 'all' ? `&kinds=${universe.enabled.join(',')}` : ''}`
      : null,
    { revalidateOnFocus: false, dedupingInterval: 60_000, keepPreviousData: true },
  );
  const items = news.data?.items ?? [];
  const sections: { id: Exclude<View, 'all'>; items: NewsItem[] }[] = [
    { id: 'trailers', items: items.filter((i) => i.trailer) },
    { id: 'upcoming', items: items.filter((i) => i.type === 'upcoming') },
    { id: 'announced', items: items.filter((i) => i.type === 'announced') },
    { id: 'edition', items: items.filter((i) => i.type === 'edition') },
    { id: 'article', items: items.filter((i) => i.type === 'article') },
  ];
  const shown = sections.filter((s) => s.items.length && (view === 'all' || view === s.id));
  return (
    <Page className="flex flex-col gap-8 pb-16">
      <div className="flex flex-col gap-4">
        <PageTitle title={t('newsPage.title')} aside={t('newsPage.aside')} />
        <div
          role="group"
          aria-label={t('catalog.kind')}
          className="no-scrollbar relative -mx-4 flex max-w-[calc(100%+2rem)] min-w-0 gap-2 overflow-x-auto px-4 md:mx-0 md:max-w-full md:px-0"
        >
          <SlidingHighlight />
          {(['all', ...universe.enabled] as DiscoverKind[]).map((k) => (
            <Pill key={k} active={kind === k} onClick={() => setKind(k)}>
              {t(`kind.${k}`)}
            </Pill>
          ))}
        </div>
        <div
          role="group"
          aria-label={t('newsPage.viewLabel')}
          className="no-scrollbar relative -mx-4 flex max-w-[calc(100%+2rem)] min-w-0 gap-1.5 overflow-x-auto px-4 text-sm md:mx-0 md:max-w-full md:px-0"
        >
          {VIEWS.filter(
            (v) => v === 'all' || sections.some((s) => s.id === v && s.items.length),
          ).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cx(
                'h-8 shrink-0 rounded-full px-3.5',
                view === v
                  ? 'bg-white/[0.14] font-semibold text-white'
                  : 'text-mid hover:text-white',
              )}
            >
              {t(`newsPage.view.${v}`)}
            </button>
          ))}
        </div>
      </div>
      <LoadNotice
        pending={!news.data && news.isLoading}
        partial={Boolean(news.data?.failed.length)}
      />
      {news.error && !news.data && <ErrorNote error={news.error} />}
      {news.data && news.data.failed.length > 0 && (
        <p className="text-muted -mt-4 text-xs">
          {t('newsPage.failed', { names: news.data.failed.join(', ') })}
        </p>
      )}
      {!news.data && !news.error && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-[2/3]" />
          ))}
        </div>
      )}
      {news.data && !shown.length && (
        <Empty title={t('newsPage.empty')}>{t('newsPage.emptyBody')}</Empty>
      )}
      {shown.map((s, index) => {
        const list = view === 'all' ? s.items.slice(0, PREVIEW) : s.items;
        const more =
          view === 'all' && s.items.length > PREVIEW ? (
            <button type="button" className={smallButton} onClick={() => setView(s.id)}>
              {t('newsPage.seeAll', { count: s.items.length })}
            </button>
          ) : undefined;
        return (
          <section key={s.id} className="flex flex-col gap-4">
            <SectionHeading num={index + 1} title={t(`newsPage.section.${s.id}`)} aside={more} />
            {s.id === 'trailers' ? (
              view === 'all' ? (
                <ScrollRow label={t('newsPage.section.trailers')}>
                  {list.map((item) => (
                    <TrailerCard key={item.id} item={item} onPlay={() => setTrailer(item)} />
                  ))}
                </ScrollRow>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((item) => (
                    <TrailerCard key={item.id} item={item} onPlay={() => setTrailer(item)} />
                  ))}
                </div>
              )
            ) : s.id === 'article' ? (
              <ul className="flex flex-col">
                {list.map((item) => (
                  <ArticleRow key={item.id} item={item} kindShown={kind === 'all'} />
                ))}
              </ul>
            ) : s.id === 'edition' ? (
              <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((item) => (
                  <EditionRow key={item.id} item={item} />
                ))}
              </ul>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
                {list.map((item) => (
                  <WorkCard
                    key={item.id}
                    item={item}
                    kindShown={kind === 'all'}
                    onTrailer={() => setTrailer(item)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      <Feeds kind={kind} kinds={kinds} onChange={() => void news.mutate()} />
      <TrailerDialog item={trailer} onClose={() => setTrailer(null)} />
    </Page>
  );
}

/** "2027", "March 2027" or "12 March 2027": as precise as the catalog knows. */
function useReleaseDate() {
  const { locale } = useI18n();
  return (value: string | null) => {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (!month) return String(year);
    const date = new Date(year, month - 1, day || 1, 12);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      ...(day ? { day: 'numeric' } : {}),
    }).format(date);
  };
}

function TrailerCard({ item, onPlay }: { item: NewsItem; onPlay: () => void }) {
  const { t } = useI18n();
  const released = useReleaseDate();
  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-2 sm:w-[340px]">
      <button
        type="button"
        onClick={onPlay}
        aria-label={t('newsPage.watchTrailer', { title: item.title })}
        className="group relative aspect-video overflow-hidden rounded-xl bg-white/[0.06]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- the video's own public still */}
        <img
          src={`https://i.ytimg.com/vi/${item.trailer}/hqdefault.jpg`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors group-hover:bg-black/40">
          <span className="flex size-14 items-center justify-center rounded-full bg-white text-black shadow-xl">
            <Play className="size-5 translate-x-px fill-current" aria-hidden />
          </span>
        </span>
      </button>
      <span className="flex min-w-0 flex-col px-0.5">
        {item.media ? (
          <MediaLink media={item.media} className="truncate font-semibold hover:underline">
            {item.title}
          </MediaLink>
        ) : (
          <span className="truncate font-semibold">{item.title}</span>
        )}
        <span className="text-muted truncate text-xs">
          {[released(item.releaseDate), item.source].filter(Boolean).join(' · ')}
        </span>
      </span>
    </div>
  );
}

function WorkCard({
  item,
  kindShown,
  onTrailer,
}: {
  item: NewsItem;
  kindShown: boolean;
  onTrailer: () => void;
}) {
  const { t } = useI18n();
  const released = useReleaseDate();
  const date = released(item.releaseDate);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {item.media ? (
        <MediaLink media={item.media} className="block">
          <Cover src={item.media.coverUrl} alt={item.title} />
        </MediaLink>
      ) : (
        <Cover src={item.imageUrl} alt={item.title} />
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        {item.media ? (
          <MediaLink
            media={item.media}
            className="line-clamp-2 text-sm leading-snug font-semibold hover:underline"
          >
            {item.title}
          </MediaLink>
        ) : (
          <span className="line-clamp-2 text-sm font-semibold">{item.title}</span>
        )}
        <span className="text-muted truncate text-xs">
          {[
            kindShown ? t(`kind.${item.kind}`) : null,
            date ? t('newsPage.releases', { date }) : t('newsPage.undated'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {item.trailer && (
          <button
            type="button"
            onClick={onTrailer}
            className="text-mid flex items-center gap-1 self-start text-xs hover:text-white"
          >
            <Play className="size-3 fill-current" aria-hidden />
            {t('newsPage.trailer')}
          </button>
        )}
      </span>
    </div>
  );
}

function EditionRow({ item }: { item: NewsItem }) {
  const released = useReleaseDate();
  return (
    <li className="border-line flex items-center gap-3 border-b py-2.5">
      <span className="w-11 shrink-0">
        <Cover src={item.imageUrl} alt="" />
      </span>
      <span className="flex min-w-0 flex-col">
        {item.media ? (
          <MediaLink media={item.media} className="truncate text-sm font-semibold hover:underline">
            {item.title}
          </MediaLink>
        ) : (
          <span className="truncate text-sm font-semibold">{item.title}</span>
        )}
        <span className="text-muted truncate text-xs">
          {[item.headline, released(item.releaseDate)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </li>
  );
}

function ArticleRow({ item, kindShown }: { item: NewsItem; kindShown: boolean }) {
  const { t } = useI18n();
  const ago = useRelativeTime();
  const [image, setImage] = useState(item.imageUrl);
  const body = (
    <>
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- the article's own picture
        <img
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImage(null)}
          className="aspect-video w-28 shrink-0 rounded-lg object-cover sm:w-40"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 font-semibold group-hover:underline">{item.title}</span>
        {item.summary && <span className="text-mid line-clamp-2 text-sm">{item.summary}</span>}
        <span className="text-muted flex items-center gap-1.5 text-xs">
          {[
            item.source,
            kindShown ? t(`kind.${item.kind}`) : null,
            item.date ? ago(item.date) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {item.url && <ExternalLink className="size-3" aria-hidden />}
        </span>
      </span>
    </>
  );
  return (
    <li className="border-line border-b">
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="group flex items-start gap-4 py-3.5"
        >
          {body}
        </a>
      ) : (
        <div className="flex items-start gap-4 py-3.5">{body}</div>
      )}
    </li>
  );
}

/** A trailer played in place (YouTube's privacy-enhanced player, started on open). */
function TrailerDialog({ item, onClose }: { item: NewsItem | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm" />
        <Dialog.Content className="theme-lock fixed top-1/2 left-1/2 z-[60] flex w-[min(1100px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 outline-none">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="truncate text-lg font-semibold text-white">
              {item?.title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t('common.close')}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.1] text-white hover:bg-white/[0.2]"
            >
              <X className="size-5" aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t('newsPage.trailer')}</Dialog.Description>
          {item?.trailer && (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${item.trailer}?autoplay=1&rel=0`}
              title={item.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              className="aspect-video w-full rounded-2xl bg-black"
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The news feeds (RSS or Atom) followed for the chosen kind: any site that publishes one. Kept
 * with the account; their articles join the kind's news.
 */
function Feeds({
  kind,
  kinds,
  onChange,
}: {
  kind: DiscoverKind;
  kinds: readonly DiscoverKind[];
  /** A feed added or removed: the news are read again. */
  onChange: () => void;
}) {
  const { t } = useI18n();
  const settings = useApi<PublicSettings>('/api/settings');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = kinds.filter((k): k is NewsFeed['kind'] => k !== 'all');
  const [picked, setPicked] = useState<NewsFeed['kind'] | null>(null);
  const target: NewsFeed['kind'] | null =
    kind !== 'all' ? kind : picked && choices.includes(picked) ? picked : (choices[0] ?? null);
  const all = settings.data?.newsFeeds ?? [];
  const mine = all.filter((f) => kind === 'all' || f.kind === kind);
  const save = async (newsFeeds: NewsFeed[]) => {
    setBusy(true);
    try {
      await settings.mutate(await send<PublicSettings>('/api/settings', 'PATCH', { newsFeeds }), {
        revalidate: false,
      });
      onChange();
      return true;
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title={t('newsPage.feeds')} />
      <p className="text-mid max-w-2xl text-sm leading-relaxed">{t('newsPage.feedsHint')}</p>
      {mine.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {mine.map((f) => (
            <li
              key={`${f.kind}|${f.url}`}
              className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] px-3.5 py-2.5 text-sm"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{f.url.replace(/^https?:\/\//, '')}</span>
                {kind === 'all' && (
                  <span className="text-muted text-xs">{t(`kind.${f.kind}`)}</span>
                )}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void save(all.filter((x) => !(x.url === f.url && x.kind === f.kind)))
                }
                className={cx(smallButton, 'text-mid shrink-0')}
              >
                {t('newsPage.feedRemove')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        settings.data && <p className="text-muted text-sm">{t('newsPage.feedsNone')}</p>
      )}
      {target && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = url.trim();
            if (!value || all.some((f) => f.url === value && f.kind === target)) return;
            if (await save([...all, { url: value, kind: target }])) setUrl('');
          }}
        >
          {kind === 'all' && choices.length > 1 && (
            <select
              aria-label={t('newsPage.feedKind')}
              value={target}
              onChange={(e) => setPicked(e.target.value as NewsFeed['kind'])}
              className="border-line rounded-full border bg-white/[0.04] px-3 py-2.5 text-sm"
            >
              {choices.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/feed.xml"
            aria-label={t('newsPage.feedUrl')}
            className="border-line min-w-0 flex-1 rounded-full border bg-white/[0.04] px-4 py-2.5 text-sm outline-none focus:border-white/30"
          />
          <button type="submit" disabled={busy} className={smallButton}>
            {t('newsPage.feedAdd')}
          </button>
        </form>
      )}
    </section>
  );
}
