import type { NextConfig } from 'next';
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
};
export default config;
