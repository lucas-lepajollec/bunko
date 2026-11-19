'use client';
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { TransientCoverError, loadCover } from '@/lib/client/cover-loader';

/** Delays before retrying a cover that failed for a temporary reason. */
const RETRIES = [3_000, 12_000];
const MAX_WARM = 1000;

/**
 * Same-origin URLs already loaded into the browser's HTTP cache during this session. Once warm, a
 * plain `<img>` hits the browser disk/memory cache on the very first paint without touching the
 * HTTP/1 transfer queue or allocating Blob copies.
 */
const warmCovers = new Set<string>();

export function markCoverWarm(url: string) {
  if (warmCovers.has(url)) warmCovers.delete(url);
  warmCovers.add(url);
  if (warmCovers.size > MAX_WARM) {
    const oldest = warmCovers.values().next().value;
    if (oldest) warmCovers.delete(oldest);
  }
}

export function clearWarmCovers() {
  warmCovers.clear();
}

export function isCoverWarm(url: string) {
  return warmCovers.has(url);
}

/**
 * External artwork renders natively so the browser's own memory/HTTP cache paints it on frame 1.
 * Cold same-origin `/api/...` artwork shares a bounded cancellable queue so a big LAN library never
 * starves JSON or navigation; once loaded once, it switches to the fast native cache path too.
 */
export function ManagedImage({
  src,
  onLoadError,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  src: string;
  onLoadError?: () => void;
}) {
  const local = src.startsWith('/api/');
  // External CDNs (AniList, TMDB, MangaDex…) and already-warm local covers bypass the JS queue.
  const direct = !local || warmCovers.has(src);
  if (direct)
    return (
      <DirectImage
        src={src}
        local={local}
        onLoadError={onLoadError}
        {...props}
      />
    );
  return <QueuedLocalImage src={src} onLoadError={onLoadError} {...props} />;
}

function DirectImage({
  src,
  local,
  onLoadError,
  className,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  src: string;
  local: boolean;
  onLoadError?: () => void;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- browser HTTP/memory cache paints immediately
    <img
      {...props}
      src={src}
      alt={props.alt ?? ''}
      decoding={props.decoding ?? 'async'}
      referrerPolicy={props.referrerPolicy ?? 'no-referrer'}
      // Transparent alt colour keeps a broken/loading image from laying out readable fallback text
      // that would stretch a card, while preserving the accessible name.
      className={className ? `${className} text-transparent` : 'text-transparent'}
      onError={() => {
        if (local) warmCovers.delete(src);
        onLoadError?.();
      }}
    />
  );
}

function QueuedLocalImage({
  src,
  onLoadError,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  src: string;
  onLoadError?: () => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const failure = useRef(onLoadError);
  const [loaded, setLoaded] = useState('');
  const urls = useRef(new Set<string>());
  const displayed = useRef('');
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );
  useEffect(() => {
    for (const url of urls.current)
      if (url !== loaded) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
  }, [loaded]);
  const priority = props.fetchPriority === 'high';
  useEffect(() => {
    failure.current = onLoadError;
  }, [onLoadError]);
  useEffect(() => {
    const ownedUrls = urls.current;
    let request: AbortController | undefined;
    let objectUrl: string | undefined;
    let disposed = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (disposed || request || objectUrl) return;
      const transfer = new AbortController();
      request = transfer;
      void loadCover(src, transfer.signal)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (disposed || transfer.signal.aborted) {
            URL.revokeObjectURL(url);
            return '';
          }
          urls.current.add(url);
          return url;
        })
        .then(async (url) => {
          if (!url || disposed || transfer.signal.aborted) return;
          const image = new Image();
          image.referrerPolicy = 'no-referrer';
          image.fetchPriority = priority ? 'high' : 'auto';
          image.src = url;
          await image.decode();
          return url;
        })
        .then((url) => {
          if (!url || disposed || transfer.signal.aborted) return;
          objectUrl = url;
          displayed.current = url;
          markCoverWarm(src);
          observer?.disconnect();
          setLoaded(url);
        })
        .catch((error) => {
          if (disposed || transfer.signal.aborted) return;
          // A busy or briefly unreachable server is not a missing cover: try again later.
          if (error instanceof TransientCoverError && tries < RETRIES.length) {
            request = undefined;
            retry = setTimeout(start, RETRIES[tries++]);
            return;
          }
          failure.current?.();
        });
    };
    const observer =
      !priority && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                start();
              } else if (!objectUrl) {
                // Scrolling past a cold card must not delay the artwork now on screen.
                request?.abort();
                request = undefined;
              }
            },
            { rootMargin: '250px' },
          )
        : undefined;
    if (observer && ref.current) observer.observe(ref.current);
    else start();
    return () => {
      disposed = true;
      clearTimeout(retry);
      observer?.disconnect();
      request?.abort();
      // The displayed image belongs to the component, not this request.
      // Keep it through source discovery and failed replacement attempts.
      for (const url of ownedUrls)
        if (url !== displayed.current) {
          URL.revokeObjectURL(url);
          ownedUrls.delete(url);
        }
    };
  }, [src, priority]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated artwork, browser HTTP cache retained by fetch
    <img
      {...props}
      ref={ref}
      src={loaded || undefined}
      style={{ ...props.style, opacity: loaded ? (props.style?.opacity ?? 1) : 0 }}
      className={
        props.className
          ? `${props.className} transition-opacity duration-150`
          : 'transition-opacity duration-150'
      }
      onError={() => failure.current?.()}
      // Until the picture is there the alternative text stays out: an empty image with a long
      // title would otherwise lay the title out as text and stretch its card (and its row).
      alt={loaded ? (props.alt ?? '') : ''}
    />
  );
}
