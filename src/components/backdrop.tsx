'use client';
import { ManagedImage } from '@/components/managed-image';
import { useEffect, useState } from 'react';
import { setAmbient } from '@/lib/client/ambient';
import { cx } from './ui';

/**
 * Full-bleed artwork behind a hero. It extends below the hero and dissolves into the page with a
 * mask (no visible edge), keeps a left shade for text legibility and a glow of the title colour.
 * A wide banner is shown sharp; otherwise (or when it fails to load) the cover candidates are tried
 * in order, blurred.
 */
export function Backdrop({
  image,
  fallback,
  color,
  className,
  mobileImage,
  ambient: ambientArt,
}: {
  /** Artwork for themes that tint the whole page (Ciné, Aurore) when this hero shows none. */
  ambient?: string | null;
  image: string | null;
  /**
   * Portrait artwork for phones: a wide banner cropped into a tall screen shows only a sliver, so
   * the cover is used there instead (sharp, behind the same shades).
   */
  mobileImage?: string | null;
  /** Cover art used blurred when there is no banner: one URL or candidates in order. */
  fallback?: string | null | (string | null | undefined)[];
  color?: string | null;
  className?: string;
}) {
  const candidates = [image, ...(Array.isArray(fallback) ? fallback : [fallback])].filter(
    (u): u is string => Boolean(u),
  );
  const key = candidates.join('|');
  const [failed, setFailed] = useState({ key, count: 0 });
  const attempt = failed.key === key ? failed.count : 0;
  const src = candidates[attempt] ?? null;
  const sharp = Boolean(image) && src === image;
  // Themes that tint the whole page with the current artwork follow this one.
  const ambient = src ?? mobileImage ?? ambientArt;
  useEffect(() => {
    if (ambient) setAmbient(ambient);
  }, [ambient]);
  return (
    <div
      aria-hidden
      className={cx('pointer-events-none absolute inset-x-0 top-0 overflow-hidden', className)}
    >
      <div
        className="absolute inset-0"
        style={{
          maskImage:
            'linear-gradient(180deg, #000 0%, #000 58%, rgba(0,0,0,0.55) 78%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(180deg, #000 0%, #000 58%, rgba(0,0,0,0.55) 78%, transparent 100%)',
        }}
      >
        {src && sharp && (
          // Wide banners (≈4.7:1): full width, a capped height (gentle zoom, never stretched over
          // the whole hero), then a long soft fade into the page.
          <ManagedImage
            src={src}
            alt=""
            onLoadError={() => setFailed({ key, count: attempt + 1 })}
            referrerPolicy="no-referrer"
            className={cx(
              'backdrop-banner absolute inset-x-0 top-0 w-full object-cover object-[center_30%]',
              mobileImage && 'hidden md:block',
            )}
            style={{
              height: 'min(100%, max(29vw, 420px))',
              maskImage:
                'linear-gradient(180deg, #000 45%, rgba(0,0,0,0.55) 72%, transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(180deg, #000 45%, rgba(0,0,0,0.55) 72%, transparent 100%)',
            }}
          />
        )}
        {src && !sharp && (
          <ManagedImage
            src={src}
            alt=""
            onLoadError={() => setFailed({ key, count: attempt + 1 })}
            referrerPolicy="no-referrer"
            className={cx(
              'absolute inset-0 size-full scale-125 object-cover opacity-40 blur-2xl',
              mobileImage && 'hidden md:block',
            )}
          />
        )}
        {mobileImage && (
          <ManagedImage
            src={mobileImage}
            alt=""
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full object-cover object-top opacity-70 md:hidden"
          />
        )}
        {/* Shades take the page colour, so they also work on light themes. */}
        <div
          className="absolute inset-0 hidden md:block"
          style={{
            background:
              'linear-gradient(90deg, var(--color-bg) 0%, color-mix(in oklab, var(--color-bg) 75%, transparent) 34%, transparent 70%)',
          }}
        />
        <div
          className="backdrop-shade absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in oklab, var(--color-bg) 55%, transparent) 0%, transparent 22%, transparent 45%, color-mix(in oklab, var(--color-bg) 60%, transparent) 75%)',
          }}
        />
        <div
          className="absolute bottom-[8%] left-[-220px] h-[600px] w-[900px] opacity-[0.13]"
          style={{
            background: color ? `radial-gradient(closest-side, ${color}, transparent)` : undefined,
          }}
        />
      </div>
    </div>
  );
}
