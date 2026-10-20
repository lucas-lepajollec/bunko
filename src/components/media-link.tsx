'use client';
import Link, { useLinkStatus } from 'next/link';
import type { ComponentProps } from 'react';
import type { UnifiedMedia } from '@/types/shared';
import { mediaHref } from '@/lib/client/api';
import { useMediaPreview } from '@/lib/client/media-navigation';
import { Spinner, cx } from './ui';

function Pending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span aria-hidden className="absolute top-2 left-2 z-10 rounded-full bg-black/70 p-1.5">
      <Spinner />
    </span>
  ) : null;
}

export function MediaLink({
  media,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href' | 'onNavigate' | 'media'> & { media: UnifiedMedia }) {
  const preview = useMediaPreview();
  return (
    <Link
      {...props}
      href={mediaHref(media.id)}
      onNavigate={() => preview(media)}
      className={cx('relative', className)}
    >
      {children}
      <Pending />
    </Link>
  );
}
