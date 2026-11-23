# Bunko Public Demo

Bunko ships an isolated, zero-SQLite, zero-disk public demo mode (`BUNKO_DEMO_MODE=true`) designed for previewing the full interface locally or on Vercel without connecting any external media servers, databases, or copyrighted files.

## Running the Demo Locally

```bash
npm run demo
```

Then open [http://127.0.0.1:2498](http://127.0.0.1:2498).

You can also pass a language handoff parameter in demo mode:
- `/?lang=en`
- `/?lang=fr`
- `/?lang=es`
- `/?lang=de`
- `/?lang=it`

## Building for Vercel

```bash
VERCEL=1 BUNKO_DEMO_MODE=true NEXT_PUBLIC_BUNKO_DEMO=true npm run build
```

When `BUNKO_DEMO_MODE=true` (or `NEXT_PUBLIC_BUNKO_DEMO=true`) is set:
- Background workers and `better-sqlite3` are completely skipped.
- `robots.txt` serves `Disallow: /` and every response includes `X-Robots-Tag: noindex, nofollow, noarchive`.
- All 30 catalog works, covers, hero banners, and sample chapter reader pages are 100% original fictional assets stored locally in `public/demo/`.
- Interactive changes (library status, `/10` ratings, favorites, episode/chapter progress, ranked lists, drag-and-drop tier lists, theme & language preferences) persist in your browser's `sessionStorage` (`bunko-demo-state-v1`) and reset instantly via the bottom-right **Reset** chip.
- External downloads, network requests to private servers, account changes, and 18+ content are strictly disabled.

## Reproducible Screenshots

To regenerate the English Ciné-theme screenshots and manifest in `docs/assets/screenshots/`:

```bash
npm run demo:capture
```
