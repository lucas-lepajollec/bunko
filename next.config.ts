import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'adm-zip'],
  poweredByHeader: false,
  devIndicators: false,
};
export default config;
