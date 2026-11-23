import type { NextConfig } from 'next';
const securityHeaders = [
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
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'adm-zip'],
  poweredByHeader: false,
  devIndicators: false,
  env: {
    // Unique per build: the browser's persisted API cache is keyed by it, so data saved by an
    // older version (with an older response shape) is never read by a newer one.
    NEXT_PUBLIC_BUNKO_BUILD: String(Date.now()),
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};
export default config;
