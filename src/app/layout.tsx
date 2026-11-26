import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from '@/components/shell';
import { PRODUCT_NAME } from '@/lib/client/brand';
import { isDemoMode } from '@/lib/demo-mode';
import { THEME_BOOT_SCRIPT } from '@/lib/themes';
import './globals.css';

export function generateMetadata(): Metadata {
  const demo = isDemoMode();
  return {
    title: demo ? `${PRODUCT_NAME} — Public Demo` : PRODUCT_NAME,
    description:
      'Self-hosted reading & media hub for manga, manhwa, comics, light novels, books, anime, series, and movies.',
    applicationName: PRODUCT_NAME,
    manifest: '/manifest.webmanifest',
    appleWebApp: {
      capable: true,
      title: PRODUCT_NAME,
    },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      ],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    robots: demo ? { index: false, follow: false, nocache: true } : undefined,
  };
}

export const viewport: Viewport = {
  themeColor: '#070b10',
  colorScheme: 'dark',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme is applied to <html> before hydration by the boot script, hence the warning opt-out.
    <html
      lang="en"
      data-theme="cine"
      data-tone="night"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
