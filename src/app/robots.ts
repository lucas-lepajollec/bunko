import type { MetadataRoute } from 'next';
import { isDemoMode } from '@/lib/demo-mode';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: isDemoMode()
      ? { userAgent: '*', disallow: '/' }
      : { userAgent: '*', allow: '/' },
  };
}
