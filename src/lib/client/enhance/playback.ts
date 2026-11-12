'use client';
import {
  expectedMs,
  loadChain,
  needsFloat,
  type ChainOptions,
  type Level,
  type Size,
} from './levels';
import { EnhanceError, Enhancer, type Capabilities } from './renderer';
import { learnCost } from './settings';

/**
 * Enhancement of a playing <video>: draws each new frame through the chosen level onto a
 * canvas laid over the video, measures what it costs now and then, and steps aside (the plain
 * video shows) whenever it cannot run: preparing, unsupported, a stream the browser will not
 * let it read, picture-in-picture or the phone's native full screen.
 */
export type EnhanceStatus =
  'off' | 'preparing' | 'on' | 'paused' | 'blocked' | 'unsupported' | 'failed';

export interface EnhanceState {
  status: EnhanceStatus;
  level: Level | null;
  /** Last measured time per frame (ms), and the frame time of the video. */
  ms: number | null;
  frameMs: number;
  source: Size | null;
  drawn: Size | null;
  /** The level could not keep up with the video. */
  slow: boolean;
  caps: Capabilities | null;
  reason: string | null;
}

export interface EnhanceTarget {
  level: Level | null;
  options: ChainOptions;
  /** The video's box on screen, device pixels. */
  box: Size;
}

const INITIAL: EnhanceState = {
  status: 'off',
  level: null,
  ms: null,
  frameMs: 1000 / 24,
  source: null,
  drawn: null,
  slow: false,
  caps: null,
  reason: null,
};

type VideoWithCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (id: number) => void;
  webkitDisplayingFullscreen?: boolean;
};

export class PlaybackEnhancer {
  private engine: Enhancer | null = null;
  private target: EnhanceTarget | null = null;
  private state: EnhanceState = INITIAL;
  private configured: string | null = null;
  private configuredSource: Size | null = null;
  private configuring: string | null = null;
  private frameRequest: number | null = null;
  private animation: number | null = null;
  private lastTime = -1;
  private lastMedia: number | null = null;
  private frameGaps: number[] = [];
  private samples: number[] = [];
  private nextSample = 0;
  private started = 0;
  private visible = false;
  private dead: EnhanceStatus | null = null;
  private destroyed = false;
  private readonly video: VideoWithCallbacks;

  constructor(
    video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly onState: (s: EnhanceState) => void,
  ) {
    this.video = video;
    for (const e of ['loadedmetadata', 'resize', 'seeked', 'play'])
      video.addEventListener(e, this.refresh);
    video.addEventListener('emptied', this.emptied);
    video.addEventListener('enterpictureinpicture', this.refresh);
    video.addEventListener('leavepictureinpicture', this.refresh);
    video.addEventListener('webkitbeginfullscreen', this.refresh);
    video.addEventListener('webkitendfullscreen', this.refresh);
    document.addEventListener('visibilitychange', this.refresh);
  }

  private set(patch: Partial<EnhanceState>) {
    const next = { ...this.state, ...patch };
    const same = (a: unknown, b: unknown) =>
      a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));
    if (Object.entries(patch).every(([k, v]) => same(this.state[k as keyof EnhanceState], v)))
      return;
    this.state = next;
    this.onState(next);
  }

  private show(on: boolean) {
    if (this.visible === on) return;
    this.visible = on;
    this.canvas.style.visibility = on ? 'visible' : 'hidden';
  }

  private get source(): Size | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    return w && h ? { w, h } : null;
  }

  private get suspended() {
    return (
      document.hidden ||
      document.pictureInPictureElement === this.video ||
      Boolean(this.video.webkitDisplayingFullscreen)
    );
  }

  /** The device can run Anime4K's levels (half-float targets); null until the engine exists. */
  get caps() {
    return this.engine?.caps ?? null;
  }

  /** Creates the engine once (WebGL2 may be missing: the state says so). */
  probe(): Capabilities | null {
    if (this.engine || this.dead) return this.engine?.caps ?? null;
    try {
      this.engine = new Enhancer(this.canvas);
      this.engine.onLost = () => this.fail('failed', 'lost');
      this.set({ caps: this.engine.caps });
      return this.engine.caps;
    } catch (e) {
      this.fail('unsupported', e instanceof Error ? e.message : 'webgl');
      return null;
    }
  }

  update(target: EnhanceTarget) {
    this.target = target;
    this.refresh();
  }

  private fail(status: EnhanceStatus, reason: string) {
    this.dead = status;
    this.stopLoop();
    this.show(false);
    // A stream the browser will not let us read: the next one (through Bunko) may be fine.
    if (status !== 'blocked') {
      this.engine?.destroy();
      this.engine = null;
      this.configured = null;
    }
    this.set({ status, reason, drawn: null });
  }

  /** A new stream in the same element: what blocked the previous one may not apply. */
  private emptied = () => {
    if (this.dead === 'blocked') {
      this.dead = null;
      this.set({ reason: null });
    }
    this.refresh();
  };

  private refresh = () => {
    if (this.destroyed || this.dead) return;
    const t = this.target;
    const source = this.source;
    if (!t?.level) {
      this.stopLoop();
      this.show(false);
      // Turned off: the GPU memory goes back now (the programs stay, turning on again is quick).
      if (this.configured !== null || this.configuring !== null) {
        this.engine?.release();
        this.configured = null;
        this.configuring = null;
        this.configuredSource = null;
      }
      this.set({ status: 'off', level: null, drawn: null, source });
      return;
    }
    if (!this.probe()) return;
    if (!source) {
      this.show(false);
      this.set({ status: 'preparing', level: t.level });
      return;
    }
    if (this.suspended) {
      this.stopLoop();
      this.show(false);
      this.set({ status: 'paused', level: t.level, source });
      return;
    }
    const key = JSON.stringify([t.level, t.options, source, t.box]);
    if (key !== this.configured && key !== this.configuring) void this.configure(key, t, source);
    else if (key === this.configured) this.startLoop();
  };

  private async configure(key: string, t: EnhanceTarget, source: Size) {
    const engine = this.engine!;
    const level = t.level!;
    this.configuring = key;
    // The previous setup keeps drawing until the new one is ready, unless the level changed.
    if (this.state.level !== level) {
      this.show(false);
      this.stopLoop();
    }
    this.set({ status: this.visible ? 'on' : 'preparing', level, source, slow: false, ms: null });
    try {
      const chain = await loadChain(level, t.options);
      if (this.configuring !== key || this.destroyed) return;
      const out = t.box;
      await engine.configure(chain, source, out, needsFloat(level));
      if (this.configuring !== key || this.destroyed) {
        // Turned off meanwhile: nothing should hold GPU memory.
        if (this.configuring === null && this.configured === null) engine.release();
        return;
      }
      this.configuring = null;
      this.configured = key;
      this.configuredSource = source;
      this.samples = [];
      this.started = performance.now();
      this.nextSample = this.started + 1500;
      this.set({ drawn: engine.drawnSize });
      this.startLoop();
      // A paused video shows its frame enhanced right away.
      if (this.video.readyState >= 2) this.frame(performance.now());
    } catch (e) {
      if (this.configuring !== key) return;
      this.configuring = null;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof EnhanceError && (e.reason === 'float' || e.reason === 'size')) {
        // This level cannot run here; the video plays as it is.
        this.show(false);
        this.stopLoop();
        this.set({ status: 'unsupported', reason: e.reason });
        return;
      }
      this.fail('failed', e instanceof Error ? e.message : String(e));
    }
  }

  private startLoop() {
    if (this.frameRequest !== null || this.animation !== null) return;
    const v = this.video;
    if (v.requestVideoFrameCallback) {
      const tick = (now: number, meta: { mediaTime: number }) => {
        this.frameRequest = v.requestVideoFrameCallback!(tick);
        if (this.lastMedia !== null) {
          const gap = meta.mediaTime - this.lastMedia;
          if (gap > 0.005 && gap < 0.2) {
            this.frameGaps.push(gap);
            if (this.frameGaps.length > 30) this.frameGaps.shift();
          }
        }
        this.lastMedia = meta.mediaTime;
        this.frame(now);
      };
      this.frameRequest = v.requestVideoFrameCallback(tick);
    } else {
      // Without frame callbacks: draw on display refreshes when the picture moved.
      const tick = (now: number) => {
        this.animation = requestAnimationFrame(tick);
        if (v.currentTime === this.lastTime && !v.seeking) return;
        this.lastTime = v.currentTime;
        this.frame(now);
      };
      this.animation = requestAnimationFrame(tick);
    }
  }

  private stopLoop() {
    if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest);
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.frameRequest = null;
    this.animation = null;
    this.lastMedia = null;
  }

  /** The video's frame time, from the frames it presents (24 fps until known). */
  private get frameMs() {
    if (this.frameGaps.length < 8) return 1000 / 24;
    const sorted = [...this.frameGaps].sort((a, b) => a - b);
    return sorted[sorted.length >> 1] * 1000;
  }

  private frame(now: number) {
    const engine = this.engine;
    if (!engine || this.configured === null || this.suspended) return;
    // The video changed size (another quality): wait for the setup that matches it.
    const src = this.configuredSource;
    if (!src || src.w !== this.video.videoWidth || src.h !== this.video.videoHeight) return;
    const measure = now >= this.nextSample && !this.video.paused;
    try {
      const t0 = performance.now();
      engine.draw(this.video);
      if (measure) {
        engine.sync();
        this.sample(performance.now() - t0, now);
      }
      if (!this.visible) {
        this.show(true);
        this.set({ status: 'on' });
      }
    } catch (e) {
      if (e instanceof EnhanceError && e.reason === 'blocked') this.fail('blocked', 'cors');
      else this.fail('failed', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * One measured frame: frequent in the first seconds, then every 10 s. Three in a row slower
   * than three quarters of the frame time mark the level slow; costs teach the automatic choice.
   */
  private sample(ms: number, now: number) {
    this.nextSample = now + (now - this.started < 12_000 ? 1500 : 10_000);
    this.samples.push(ms);
    if (this.samples.length > 5) this.samples.shift();
    const frameMs = this.frameMs;
    const median = [...this.samples].sort((a, b) => a - b)[this.samples.length >> 1];
    const slow = this.samples.length >= 3 && median > frameMs * 0.75;
    this.set({ ms: Math.round(median * 10) / 10, frameMs, slow });
    const t = this.target;
    const source = this.source;
    if (this.samples.length >= 3 && t?.level && source) {
      const unit = expectedMs(t.level, { [t.level]: 1 }, source, t.box);
      if (unit) learnCost(t.level, median / unit);
    }
  }

  destroy() {
    this.destroyed = true;
    this.stopLoop();
    const v = this.video;
    for (const e of ['loadedmetadata', 'resize', 'seeked', 'play'])
      v.removeEventListener(e, this.refresh);
    v.removeEventListener('emptied', this.emptied);
    v.removeEventListener('enterpictureinpicture', this.refresh);
    v.removeEventListener('leavepictureinpicture', this.refresh);
    v.removeEventListener('webkitbeginfullscreen', this.refresh);
    v.removeEventListener('webkitendfullscreen', this.refresh);
    document.removeEventListener('visibilitychange', this.refresh);
    this.engine?.destroy();
    this.engine = null;
  }
}
