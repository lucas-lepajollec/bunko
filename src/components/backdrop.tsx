'use client';
import { cx } from './ui';

/**
 * Full-bleed artwork behind a hero. It extends below the hero and dissolves into the page with a
 * mask (no visible edge), keeps a left shade for text legibility and a glow of the title colour.
 */
export function Backdrop({
  image,
  fallback,
  color,
  className,
}: {
  image: string | null;
  /** Used blurred when there is no wide banner (cover art). */
  fallback?: string | null;
  color?: string | null;
  className?: string;
}) {
  const src = image ?? fallback ?? null;
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
          // eslint-disable-next-line @next/next/no-img-element -- remote artwork
          <img
            src={src}
            alt=""
            referrerPolicy="no-referrer"
            className={cx(
              'absolute inset-0 size-full object-cover object-[70%_center] md:object-[center_25%]',
              !image && 'scale-125 opacity-40 blur-2xl',
            )}
          />
        )}
        <div className="absolute inset-0 hidden bg-[linear-gradient(90deg,#0b0a09_0%,rgba(11,10,9,0.75)_34%,rgba(11,10,9,0)_70%)] md:block" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(11,10,9,0.55)_0%,rgba(11,10,9,0)_22%,rgba(11,10,9,0)_45%,rgba(11,10,9,0.6)_75%)]" />
        <div
          className="absolute bottom-[8%] left-[-220px] h-[600px] w-[900px] rounded-full opacity-[0.13] blur-[120px]"
          style={{ background: color ?? 'transparent' }}
        />
      </div>
    </div>
  );
}
