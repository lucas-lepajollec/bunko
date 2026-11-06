'use client';
import Link from 'next/link';
import { Download } from 'lucide-react';
import type { BookFile } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Empty, ErrorNote, SectionHeading, Skeleton, cx, smallButton } from './ui';

export const bookHref = (mediaId: string, key: string) =>
  `/book/${key}?media=${encodeURIComponent(mediaId)}`;

/** The file to open from the sheet: the last one read and not finished, else the next one. */
export function nextBook(files: BookFile[]): BookFile | null {
  const started = files
    .filter((f) => f.progress)
    .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt))[0];
  if (started && started.progress!.fraction < 0.995) return started;
  if (started) return files[files.indexOf(started) + 1] ?? started;
  return files[0] ?? null;
}

export function useBooks(mediaId: string, owned: boolean) {
  return useApi<BookFile[]>(owned ? `/api/books?media=${encodeURIComponent(mediaId)}` : null);
}

/** A book or novel's files in the library, each readable in Bunko with its own progress. */
export function BookShelf({ mediaId, owned }: { mediaId: string; owned: boolean }) {
  const { t, n } = useI18n();
  const books = useBooks(mediaId, owned);
  if (!owned) return <Empty title={t('novel.title')}>{t('novel.body')}</Empty>;
  const files = books.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        id="toc"
        num={1}
        title={t('books.title')}
        aside={books.data ? t('books.aside', { count: n(files.length) }) : undefined}
      />
      {books.error && !books.data ? (
        <ErrorNote error={books.error} />
      ) : !books.data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <p className="text-mid text-sm">{t('books.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => {
            const done = (f.progress?.fraction ?? 0) >= 0.995;
            const percent = Math.round((f.progress?.fraction ?? 0) * 100);
            return (
              <li
                key={f.key}
                className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 md:gap-4 md:px-4"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-semibold">
                      {f.volume !== null ? t('chapters.volume', { v: n(f.volume) }) : f.name}
                    </span>
                    <span className="text-muted shrink-0 text-[11px] tracking-[0.12em] uppercase">
                      {f.format}
                      {f.sizeBytes
                        ? ` · ${t('books.size', { n: n(Math.max(0.1, Math.round(f.sizeBytes / 104857.6) / 10)) })}`
                        : ''}
                    </span>
                  </span>
                  {f.volume !== null && (
                    <span className="text-muted truncate text-xs">{f.name}</span>
                  )}
                  {f.progress && (
                    <span className="h-1 max-w-[320px] overflow-hidden rounded-full bg-white/10">
                      <span
                        className="block h-full rounded-full bg-[var(--accent,#e2dbd0)]"
                        style={{ width: `${Math.max(3, percent)}%` }}
                      />
                    </span>
                  )}
                </span>
                <a
                  href={`/api/books/file/${encodeURIComponent(mediaId)}/${f.key}?download=1`}
                  aria-label={t('book.download')}
                  title={t('book.download')}
                  className="text-muted hidden size-9 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white sm:flex"
                >
                  <Download size={17} />
                </a>
                <Link href={bookHref(mediaId, f.key)} className={cx(smallButton, 'shrink-0')}>
                  {done
                    ? t('books.reread')
                    : f.progress
                      ? t('books.resume', { percent: n(percent) })
                      : t('books.read')}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
