'use client';
import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { loadCover } from '@/lib/client/cover-loader';

/** Same-origin artwork shares two cancellable transfers; offscreen cards do no work. */
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
  const [loaded, setLoaded] = useState({ source: '', url: '' });
  const local = src.startsWith('/api/');
  const priority = props.fetchPriority === 'high';
  useEffect(() => {
    failure.current = onLoadError;
  }, [onLoadError]);
  useEffect(() => {
    if (!local) return;
    let request: AbortController | undefined;
    let objectUrl: string | undefined;
    let disposed = false;
    const start = () => {
      if (disposed || request || objectUrl) return;
      const transfer = new AbortController();
      request = transfer;
      void loadCover(src, transfer.signal)
        .then((blob) => {
          if (disposed || transfer.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          observer?.disconnect();
          setLoaded({ source: src, url: objectUrl });
        })
        .catch(() => {
          if (!disposed && !transfer.signal.aborted) failure.current?.();
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
      observer?.disconnect();
      request?.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, local, priority]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- authenticated artwork, browser HTTP cache retained by fetch
    <img
      {...props}
      ref={ref}
      src={local ? (loaded.source === src ? loaded.url : undefined) : src}
      onError={() => failure.current?.()}
      alt={props.alt ?? ''}
    />
  );
}
