import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from '@/components/shell';
import { PRODUCT_NAME } from '@/lib/client/brand';
import './globals.css';

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: 'Discover, download and follow manga, webtoons and light novels into Kavita.',
};

export const viewport: Viewport = { themeColor: '#0b0a09', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
