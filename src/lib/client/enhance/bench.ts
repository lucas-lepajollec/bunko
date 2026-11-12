'use client';
import {
  BENCH_OUTPUT,
  BENCH_SOURCE,
  LEVELS,
  loadChain,
  needsFloat,
  type Bench,
  type ChainOptions,
  type Level,
} from './levels';
import { EnhanceError, Enhancer, type Capabilities } from './renderer';

/**
 * A test picture drawn by the browser (no download): flat colours with dark outlines like an
 * animation cel, gradients, thin lines and text, the details enhancement changes the most.
 */
export function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 1280;
  ctx.save();
  ctx.scale(s, (h / 720) * 1);
  const sky = ctx.createLinearGradient(0, 0, 0, 720);
  sky.addColorStop(0, '#5aa6e8');
  sky.addColorStop(0.6, '#bfe0f7');
  sky.addColorStop(1, '#f6e7c8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const outline = (width = 4) => {
    ctx.strokeStyle = '#1b1620';
    ctx.lineWidth = width;
    ctx.stroke();
  };
  // Sun and clouds.
  ctx.beginPath();
  ctx.arc(1060, 140, 70, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd35c';
  ctx.fill();
  outline();
  for (const [x, y, r] of [
    [220, 130, 46],
    [280, 110, 60],
    [350, 135, 44],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  // Hills.
  ctx.beginPath();
  ctx.moveTo(0, 520);
  ctx.bezierCurveTo(260, 380, 420, 470, 640, 450);
  ctx.bezierCurveTo(860, 430, 1040, 360, 1280, 470);
  ctx.lineTo(1280, 720);
  ctx.lineTo(0, 720);
  ctx.closePath();
  ctx.fillStyle = '#6cbf5a';
  ctx.fill();
  outline(5);
  ctx.beginPath();
  ctx.moveTo(0, 610);
  ctx.bezierCurveTo(300, 540, 700, 640, 1280, 560);
  ctx.lineTo(1280, 720);
  ctx.lineTo(0, 720);
  ctx.closePath();
  ctx.fillStyle = '#4f9a45';
  ctx.fill();
  outline(5);
  // A face.
  ctx.beginPath();
  ctx.arc(640, 330, 120, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe3cf';
  ctx.fill();
  outline(5);
  ctx.beginPath();
  ctx.moveTo(520, 300);
  ctx.bezierCurveTo(540, 170, 760, 170, 765, 300);
  ctx.bezierCurveTo(720, 240, 600, 230, 520, 300);
  ctx.fillStyle = '#3b2a4f';
  ctx.fill();
  outline(4);
  for (const x of [595, 690]) {
    ctx.beginPath();
    ctx.ellipse(x, 345, 16, 24, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#2e5fa8';
    ctx.fill();
    outline(3);
    ctx.beginPath();
    ctx.arc(x - 5, 336, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(642, 395, 26, 0.15 * Math.PI, 0.85 * Math.PI);
  outline(3);
  // Fine lines: hair strands, a fan of thin rays, hatching.
  ctx.strokeStyle = '#1b1620';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.moveTo(560 + i * 22, 215);
    ctx.quadraticCurveTo(580 + i * 20, 250, 560 + i * 24, 290);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 0.5;
    ctx.beginPath();
    ctx.moveTo(60, 700);
    ctx.lineTo(60 + Math.cos(a) * 260, 700 - Math.sin(a) * 260);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (let i = 0; i < 24; i++) {
    ctx.beginPath();
    ctx.moveTo(960 + i * 9, 560);
    ctx.lineTo(1000 + i * 9, 680);
    ctx.stroke();
  }
  // Text, large and small.
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px sans-serif';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#1b1620';
  ctx.strokeText('Bunko 文庫', 380, 640);
  ctx.fillText('Bunko 文庫', 380, 640);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#1b1620';
  ctx.fillText('The quick brown fox jumps over the lazy dog · 0123456789', 380, 680);
  ctx.restore();
}

/** The test picture as a low-quality video frame: half size, heavy JPEG compression. */
export async function degradedScene(): Promise<ImageBitmap | HTMLCanvasElement> {
  const full = document.createElement('canvas');
  full.width = 1280;
  full.height = 720;
  drawScene(full.getContext('2d')!, 1280, 720);
  const small = document.createElement('canvas');
  small.width = 640;
  small.height = 360;
  const ctx = small.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, 640, 360);
  const blob = await new Promise<Blob | null>((r) => small.toBlob(r, 'image/jpeg', 0.35));
  if (!blob || typeof createImageBitmap !== 'function') return small;
  try {
    return await createImageBitmap(blob);
  } catch {
    return small;
  }
}

export interface BenchProgress {
  level: Level;
  done: number;
  total: number;
}

/**
 * Measures each level on this device: the test picture at 1280×720 enlarged to 2560×1440, the
 * average of a few frames once compiled. A level slower than 250 ms a frame is not tried longer.
 */
export async function runBench(
  options: ChainOptions,
  onProgress: (p: BenchProgress) => void,
  signal?: AbortSignal,
): Promise<{ bench: Bench; caps: Capabilities; errors: Partial<Record<Level, string>> }> {
  const canvas = document.createElement('canvas');
  const engine = new Enhancer(canvas);
  const frame = document.createElement('canvas');
  frame.width = BENCH_SOURCE.w;
  frame.height = BENCH_SOURCE.h;
  drawScene(frame.getContext('2d')!, frame.width, frame.height);
  const bench: Bench = {};
  const errors: Partial<Record<Level, string>> = {};
  const levels = LEVELS.filter((l) => engine.caps.floatTargets || !needsFloat(l));
  try {
    for (const [i, level] of levels.entries()) {
      if (signal?.aborted) break;
      onProgress({ level, done: i, total: levels.length });
      try {
        await engine.configure(
          await loadChain(level, options),
          BENCH_SOURCE,
          BENCH_OUTPUT,
          needsFloat(level),
        );
        const first = engine.time(frame, 2);
        const ms =
          first > 250
            ? first
            : engine.time(frame, Math.max(4, Math.min(30, Math.round(400 / first))));
        bench[level] = Math.round(ms * 100) / 100;
      } catch (e) {
        if (engine.isLost) throw new EnhanceError('lost', 'GPU context lost');
        errors[level] = e instanceof Error ? e.message : String(e);
      }
      // Lets the page repaint between levels.
      await new Promise((r) => setTimeout(r, 30));
    }
    onProgress({ level: levels.at(-1)!, done: levels.length, total: levels.length });
    return { bench, caps: engine.caps, errors };
  } finally {
    engine.destroy();
  }
}
