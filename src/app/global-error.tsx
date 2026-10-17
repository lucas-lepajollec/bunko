'use client';
import { useEffect } from 'react';
import { clearPersistentCache } from '@/lib/client/cache';
import { reloadOnceForStaleBuild } from './error';

/** Errors in the root layout itself: plain markup (no providers are available here). */
export default function GlobalError({ error }: { error: Error }) {
  useEffect(() => {
    clearPersistentCache();
    console.error(error);
    reloadOnceForStaleBuild(error);
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{ background: '#0b0a09', color: '#f2eee8', fontFamily: 'system-ui, sans-serif' }}
      >
        <main style={{ maxWidth: 420, margin: '20vh auto', padding: 16 }}>
          <h1 style={{ fontSize: 26 }}>Bunko</h1>
          <p style={{ opacity: 0.75 }}>Something went wrong. Une erreur est survenue.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              padding: '10px 18px',
              borderRadius: 999,
              border: 0,
              background: '#f2eee8',
              color: '#0b0a09',
              fontWeight: 600,
            }}
          >
            Reload · Recharger
          </button>
        </main>
      </body>
    </html>
  );
}
