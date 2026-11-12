/**
 * What the picture enhancement can do, from cheapest to richest, and which level suits a video
 * on a device. Everything here is pure: the player, the settings page and the tests share it.
 *
 * - sharpen: AMD RCAS at the video's own size (any picture, any device; the browser enlarges).
 * - fsr: AMD FSR 1, edge-adaptive upscale to the screen then RCAS (filmed pictures).
 * - a4k-s / a4k-m / a4k-vl: Anime4K restore (+ ×2 upscale when the screen is larger), three
 *   network sizes (drawn pictures).
 */
export const LEVELS = ['sharpen', 'fsr', 'a4k-s', 'a4k-m', 'a4k-vl'] as const;
export type Level = (typeof LEVELS)[number];
/** Drawn (anime) or filmed (series, films) picture. */
export type Picture = 'drawn' | 'filmed';
/** Anime4K's restore styles: A sharp, B soft (blurry sources), C denoise (noisy sources). */
export type Style = 'A' | 'B' | 'C';

/** Levels that make sense for a picture, cheapest first (the automatic choice climbs it). */
export const LADDER: Record<Picture, readonly Level[]> = {
  drawn: ['sharpen', 'a4k-s', 'a4k-m', 'a4k-vl'],
  filmed: ['sharpen', 'fsr'],
};
/** Anime4K's networks need half-float render targets (negative values between layers). */
export const needsFloat = (level: Level) => level.startsWith('a4k');

export interface ChainOptions {
  style: Style;
  /** Anime4K's line darkening, appended to the chain. */
  darken: boolean;
}

type Loader = () => Promise<{ default: string }>;
const A4K: Record<string, Loader> = {
  clamp: () => import('./shaders/a4k-clamp-highlights'),
  darken: () => import('./shaders/a4k-darken-hq'),
  'restore-s': () => import('./shaders/a4k-restore-s'),
  'restore-m': () => import('./shaders/a4k-restore-m'),
  'restore-vl': () => import('./shaders/a4k-restore-vl'),
  'restore-soft-s': () => import('./shaders/a4k-restore-soft-s'),
  'restore-soft-m': () => import('./shaders/a4k-restore-soft-m'),
  'restore-soft-vl': () => import('./shaders/a4k-restore-soft-vl'),
  'upscale-s': () => import('./shaders/a4k-upscale-x2-s'),
  'upscale-m': () => import('./shaders/a4k-upscale-x2-m'),
  'upscale-vl': () => import('./shaders/a4k-upscale-x2-vl'),
  'upscale-denoise-s': () => import('./shaders/a4k-upscale-denoise-x2-s'),
  'upscale-denoise-m': () => import('./shaders/a4k-upscale-denoise-x2-m'),
  'upscale-denoise-vl': () => import('./shaders/a4k-upscale-denoise-x2-vl'),
};

/**
 * The shader files of a level, in order (Anime4K's standard mpv modes: A = clamp, restore,
 * upscale; B = soft restore; C = denoising upscale without restore).
 */
export function chainFiles(level: Level, o: ChainOptions): string[] {
  if (level === 'sharpen') return ['rcas-0.6'];
  if (level === 'fsr') return ['easu', 'rcas-0.25'];
  const size = level.slice(4);
  const files = ['clamp'];
  if (o.style === 'A') files.push(`restore-${size}`, `upscale-${size}`);
  else if (o.style === 'B') files.push(`restore-soft-${size}`, `upscale-${size}`);
  else files.push(`upscale-denoise-${size}`);
  // A second ×2 for small videos on large screens; its own condition skips it otherwise.
  files.push(`upscale-${size === 'vl' ? 'm' : 's'}`);
  if (o.darken) files.push('darken');
  return files;
}

/** Shader sources of a level, loaded on demand (cached by the bundler after the first time). */
export async function loadChain(level: Level, o: ChainOptions): Promise<string[]> {
  const names = chainFiles(level, o);
  const fsr = names.some((n) => !(n in A4K)) ? await import('./shaders/fsr') : null;
  return Promise.all(
    names.map(async (n) => {
      if (n === 'easu') return fsr!.EASU;
      if (n.startsWith('rcas-')) return fsr!.rcas(Number(n.slice(5)));
      return (await A4K[n]()).default;
    }),
  );
}

export interface Size {
  w: number;
  h: number;
}

/**
 * Measured cost of each level on this device, in milliseconds per frame for a 1280×720 video
 * shown at 2560×1440 (see bench.ts). Missing = not measured or failed.
 */
export type Bench = Partial<Record<Level, number>>;
export const BENCH_SOURCE: Size = { w: 1280, h: 720 };
export const BENCH_OUTPUT: Size = { w: 2560, h: 1440 };

/**
 * A level's expected cost for a video: Anime4K and sharpening work at the video's size, FSR at
 * the screen's. Sizes are in device pixels.
 */
export function expectedMs(level: Level, bench: Bench, source: Size, output: Size) {
  const base = bench[level];
  if (base === undefined) return null;
  const area = (s: Size) => s.w * s.h;
  const ratio =
    level === 'fsr'
      ? area(output) / area(BENCH_OUTPUT)
      : level === 'sharpen'
        ? Math.max(area(source), area(output) / 4) / area(BENCH_SOURCE)
        : area(source) / area(BENCH_SOURCE);
  return base * ratio;
}

export interface AutoInput {
  picture: Picture;
  source: Size;
  /** The video's box on screen, device pixels. */
  output: Size;
  fps: number;
  bench: Bench;
  /** No measurement yet: a phone or tablet stays on the light levels. */
  handheld: boolean;
  /** Battery saving: on battery, only the cheapest level. */
  onBattery: boolean;
  floatTargets: boolean;
  /** Levels that proved too slow during this playback. */
  tooSlow?: readonly Level[];
}

/** Share of a frame's time the enhancement may take (decoding and display need the rest). */
export const BUDGET_SHARE = 0.45;

/**
 * The richest level of the picture's ladder this device should run smoothly: by its measured
 * cost when known, else a cautious default that the player lowers if frames come late.
 */
export function autoLevel(a: AutoInput): Level | null {
  const ladder = LADDER[a.picture].filter(
    (l) => (a.floatTargets || !needsFloat(l)) && !a.tooSlow?.includes(l),
  );
  if (!ladder.length) return null;
  if (a.onBattery) return ladder[0];
  const budget = (1000 / Math.max(1, a.fps)) * BUDGET_SHARE;
  const measured = ladder.filter((l) => a.bench[l] !== undefined);
  if (measured.length) {
    let best = -1;
    for (const [i, l] of ladder.entries()) {
      const ms = expectedMs(l, a.bench, a.source, a.output);
      if (ms !== null && ms <= budget) best = i;
    }
    // Plenty of room and the next level never measured: try it (playback measures it, and
    // lowers it again if it cannot keep up).
    const next = ladder[best + 1];
    const ms = best >= 0 ? expectedMs(ladder[best], a.bench, a.source, a.output)! : 0;
    if (next && a.bench[next] === undefined && ms <= budget * 0.3) return next;
    return best >= 0 ? ladder[best] : null;
  }
  if (a.handheld) return ladder[0];
  // Unmeasured desktop: the middle of the ladder, lowered at runtime if it cannot keep up.
  return a.picture === 'drawn' ? (ladder.find((l) => l === 'a4k-s') ?? ladder[0]) : ladder.at(-1)!;
}

/** The next cheaper level of the ladder, for a playback that cannot keep up. */
export function lowerLevel(picture: Picture, level: Level): Level | null {
  const ladder = LADDER[picture];
  const i = ladder.indexOf(level);
  return i > 0 ? ladder[i - 1] : null;
}

/**
 * The size the enhancement draws at: the video's box on screen (device pixels), never smaller
 * than the video, at most 4K-sized and within the GPU's limits.
 */
export function outputSize(source: Size, box: Size, maxTexture: number): Size {
  const fit = Math.min(box.w / source.w, box.h / source.h);
  const cap = Math.min(
    Math.sqrt((3840 * 2160) / (source.w * source.h)),
    maxTexture / source.w,
    maxTexture / source.h,
  );
  const scale = Math.max(1, Math.min(fit, cap));
  return { w: Math.floor(source.w * scale), h: Math.floor(source.h * scale) };
}
