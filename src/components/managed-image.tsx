'use client';
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { TransientCoverError, loadCover } from '@/lib/client/cover-loader';

/** Delays before retrying a cover that failed for a temporary reason. */
const RETRIES = [3_000, 12_000];

/** Same-origin artwork shares a few cancellable transfers; offscreen cards do no work. */
export function ManagedImage({
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
  const local = src.startsWith('/api/');
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
      const replacement = local
        ? loadCover(src, transfer.signal).then((blob) => {
            const url = URL.createObjectURL(blob);
            if (disposed || transfer.signal.aborted) {
              URL.revokeObjectURL(url);
              return '';
            }
            urls.current.add(url);
            return url;
          })
        : Promise.resolve(src);
      void replacement
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
            { rootMargin: '200px' },
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
  }, [src, local, priority]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated artwork, browser HTTP cache retained by fetch
    <img
      {...props}
      ref={ref}
      src={loaded || undefined}
      style={{ ...props.style, visibility: loaded ? props.style?.visibility : 'hidden' }}
      onError={() => failure.current?.()}
      alt={props.alt ?? ''}
    />
  );
}
