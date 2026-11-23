import type { NextConfig } from 'next';
const baseSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  },
];
const config: NextConfig = {
  // Docker/self-hosted releases use Next's minimal standalone server. Vercel creates its own
  // Functions and build output, so omit standalone when VERCEL=1 is provided by the platform.
  output: process.env.VERCEL === '1' ? undefined : 'standalone',
  serverExternalPackages: ['better-sqlite3', 'adm-zip'],
  poweredByHeader: false,
  devIndicators: false,
  env: {
    // Unique per build: the browser's persisted API cache is keyed by it, so data saved by an
    // older version (with an older response shape) is never read by a newer one.
    NEXT_PUBLIC_BUNKO_BUILD: String(Date.now()),
  },
  async headers() {
    const headers = [...baseSecurityHeaders];
    if (
      process.env.BUNKO_DEMO_MODE === 'true' ||
      process.env.NEXT_PUBLIC_BUNKO_DEMO === 'true'
    ) {
      headers.push({
        key: 'X-Robots-Tag',
        value: 'noindex, nofollow, noarchive',
      });
    }
    return [{ source: '/(.*)', headers }];
  },
};
export default config;
