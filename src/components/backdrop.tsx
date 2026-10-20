'use client';
import { ManagedImage } from '@/components/managed-image';
import { useState } from 'react';
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
}: {
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
        {src && (
          <ManagedImage
            key={src}
            src={src}
            alt=""
            onLoadError={() => setFailed({ key, count: attempt + 1 })}
            referrerPolicy="no-referrer"
            className={cx(
              'absolute inset-0 size-full object-cover object-[70%_center] md:object-[center_25%]',
              !sharp && 'scale-125 opacity-40 blur-2xl',
              mobileImage && 'hidden md:block',
            )}
          />
        )}
        {mobileImage && (
          <ManagedImage
            key={`m:${mobileImage}`}
            src={mobileImage}
            alt=""
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full object-cover object-top opacity-70 md:hidden"
          />
        )}
        <div className="absolute inset-0 hidden bg-[linear-gradient(90deg,#0b0a09_0%,rgba(11,10,9,0.75)_34%,rgba(11,10,9,0)_70%)] md:block" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(11,10,9,0.55)_0%,rgba(11,10,9,0)_22%,rgba(11,10,9,0)_45%,rgba(11,10,9,0.6)_75%)]" />
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
