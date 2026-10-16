'use client';
import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { LibraryProgress, UnifiedMedia } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { ApiFailure } from '@/lib/client/api';

/** Class names where later Tailwind utilities override earlier ones (e.g. a caller's width). */
export const cx = (...values: ClassValue[]) => twMerge(clsx(values));

export function roman(n: number) {
  const map: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of map)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return `${out}.`;
}

/** Cover image with a quiet serif placeholder when the artwork is missing or fails to load. */
export function Cover({
  src,
  alt = '',
  className,
  style,
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  if (!src || failed)
    return (
      <span
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        className={cx(
          'book bg-hover text-faint @container flex aspect-[2/3] items-center justify-center p-2 text-center font-serif text-sm italic',
          className,
        )}
        style={style}
      >
        {/* The label only fits medium and large tiles. */}
        <span className="hidden @[72px]:inline">{t('common.noCover')}</span>
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- covers come from arbitrary providers and the authenticated proxy
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cx('book aspect-[2/3] w-full object-cover', className)}
      style={style}
    />
  );
}

export function SectionHeading({
  num,
  title,
  aside,
  href,
  linkLabel,
  id,
  as: Tag = 'h2',
}: {
  num?: number;
  title: string;
  aside?: string;
  href?: string;
  linkLabel?: string;
  id?: string;
  as?: 'h1' | 'h2';
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {num !== undefined && (
        <span className="text-muted font-serif text-lg md:text-xl">{roman(num)}</span>
      )}
      <Tag id={id} className="font-display text-[23px] font-bold tracking-[-0.02em] md:text-[30px]">
        {title}
      </Tag>
      {aside && (
        <span className="text-muted font-serif text-[17px] italic md:text-[22px]">{aside}</span>
      )}
      {href && linkLabel && (
        <Link href={href} className="text-muted hover:text-fg ml-auto text-[13px]">
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}

export function PageTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:gap-5">
      <h1 className="font-display text-[40px] leading-none font-extrabold tracking-[-0.04em] md:text-[60px]">
        {title}
      </h1>
      {aside && (
        <span className="text-muted font-serif text-[19px] italic md:text-[26px]">{aside}</span>
      )}
    </div>
  );
}

/** Pill used for filters and scopes; the active one is filled. */
export function Pill({
  active,
  onClick,
  children,
  className,
  ...rest
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm transition-colors',
        active ? 'bg-fg text-bg font-semibold' : 'text-fg bg-white/[0.07] hover:bg-white/[0.12]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Underlined tabs (bookshop index style). */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; count?: number | string; tone?: 'bad' }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="border-line no-scrollbar flex gap-6 overflow-x-auto border-b md:gap-8"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className={cx(
            'shrink-0 border-b-2 pb-3 text-[15px] md:text-base',
            value === item.id
              ? 'border-fg font-semibold text-white'
              : 'text-mid border-transparent',
          )}
        >
          {item.label}{' '}
          {item.count !== undefined && (
            <span
              className={cx('font-serif italic', item.tone === 'bad' ? 'text-bad' : 'text-muted')}
            >
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Segmented control (mobile scopes, fiche sections). */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="grid rounded-full bg-white/[0.07] p-1"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className={cx(
            'h-9 truncate rounded-full px-2 text-sm',
            value === item.id ? 'bg-fg text-bg font-semibold' : 'text-fg',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Read (solid) / owned (tinted) / released (track) on one line. */
export function ProgressBar({
  progress,
  color,
  className,
}: {
  progress: Pick<LibraryProgress, 'read' | 'owned' | 'released'>;
  color?: string | null;
  className?: string;
}) {
  const total = Math.max(progress.released ?? 0, progress.owned, progress.read ?? 0, 1);
  const owned = Math.min(100, (progress.owned / total) * 100);
  const read = Math.min(100, ((progress.read ?? 0) / total) * 100);
  const accent = color ?? 'var(--accent)';
  return (
    <span
      className={cx('relative block h-1 overflow-hidden rounded-full bg-white/[0.12]', className)}
    >
      <span
        className="absolute inset-y-0 left-0 opacity-35"
        style={{ width: `${owned}%`, background: accent }}
      />
      <span
        className="absolute inset-y-0 left-0"
        style={{ width: `${read}%`, background: accent }}
      />
    </span>
  );
}

export function Dot({
  tone,
  className,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'idle' | 'accent';
  className?: string;
}) {
  const color = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    bad: 'var(--color-bad)',
    idle: '#4b4640',
    accent: 'var(--accent)',
  }[tone];
  return (
    <span
      aria-hidden
      className={cx('inline-block size-2 shrink-0 rounded-full', className)}
      style={{ background: color }}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('skeleton block rounded', className)} />;
}

export function PosterSkeletons({ count, className }: { count: number; className?: string }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cx('flex flex-col gap-2', className)}>
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="h-3 w-3/4" />
        </span>
      ))}
    </>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl bg-white/[0.04] p-6 md:p-8">
      <p className="font-serif text-2xl leading-tight">{title}</p>
      {children && <div className="text-mid max-w-xl text-sm leading-relaxed">{children}</div>}
      {action}
    </div>
  );
}

/** Translated error line for a failed API call. */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const { t } = useI18n();
  return (
    <p role="alert" className={cx('text-bad text-sm', className)}>
      {errorText(t, error)}
    </p>
  );
}

export function errorText(t: (k: string) => string, error: unknown) {
  const code = error instanceof ApiFailure ? error.code : 'NETWORK_ERROR';
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t('error.generic') : text;
}

/** Providers spell publication status differently (AniList, MangaDex, Suwayomi). */
export function statusKey(status: string) {
  const s = status.toLowerCase();
  if (/finish|complet/.test(s)) return 'finished';
  if (/releas|ongoing|publishing/.test(s)) return 'releasing';
  if (/hiatus/.test(s)) return 'hiatus';
  if (/cancel/.test(s)) return 'cancelled';
  if (/not_yet|upcoming/.test(s)) return 'upcoming';
  return 'unknown';
}

export function useMediaMeta() {
  const { t } = useI18n();
  return (m: Pick<UnifiedMedia, 'format' | 'type' | 'year' | 'status'>, withStatus = false) =>
    [
      m.format ? t(`format.${m.format}`) : t(`type.${m.type}`),
      m.year,
      withStatus && m.status ? t(`status.${statusKey(m.status)}`) : null,
    ]
      .filter(Boolean)
      .join(' · ');
}

export const primaryButton =
  'inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[15px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50';
export const ghostButton =
  'inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white/[0.14] px-6 text-[15px] text-white backdrop-blur-md transition-colors hover:bg-white/[0.2] disabled:opacity-50';
export const smallButton =
  'inline-flex h-9 items-center justify-center gap-2 rounded-full bg-white/[0.1] px-4 text-[13px] text-fg transition-colors hover:bg-white/[0.16] disabled:opacity-50';
export const field =
  'h-11 w-full rounded-xl border border-line bg-raised px-3.5 text-sm text-fg outline-none placeholder:text-faint focus:border-line-strong';

/** The opening sentence of a synopsis, used as an editorial quote. */
export function firstSentence(text: string | null) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^.{40,220}?[.!?](?=\s|$)/);
  return (match?.[0] ?? clean.slice(0, 200)).trim();
}
