'use client';
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  autoLevel,
  needsFloat,
  outputSize,
  type Level,
  type Picture,
  type Size,
} from '@/lib/client/enhance/levels';
import { PlaybackEnhancer, type EnhanceState } from '@/lib/client/enhance/playback';
import { readEnhance, useEnhanceSettings } from '@/lib/client/enhance/settings';

/** The player's choice for this playback: follow the settings, off, or one level. */
export type EnhanceChoice = 'settings' | 'off' | Level;

/** Phones and tablets: light levels until this device has been measured. */
export function isHandheld() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(pointer: coarse)').matches && Math.max(screen.width, screen.height) < 1400
  );
}

type BatteryManager = EventTarget & { charging: boolean };
let battery: BatteryManager | null = null;
const batteryListeners = new Set<() => void>();
/** On battery (laptops, phones), where the browser says so; unknown counts as plugged in. */
function useOnBattery() {
  return useSyncExternalStore(
    (l) => {
      batteryListeners.add(l);
      const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
      if (!battery && nav.getBattery)
        void nav
          .getBattery()
          .then((b) => {
            battery = b;
            b.addEventListener('chargingchange', () => batteryListeners.forEach((f) => f()));
            batteryListeners.forEach((f) => f());
          })
          .catch(() => undefined);
      return () => batteryListeners.delete(l);
    },
    () => (battery ? !battery.charging : false),
    () => false,
  );
}

/**
 * The enhanced picture over a video, and the subtitles it would otherwise cover. Reports what
 * runs through `onState` (the player's menu shows it).
 */
export function EnhanceLayer({
  video,
  frame,
  picture,
  choice,
  onState,
}: {
  video: RefObject<HTMLVideoElement | null>;
  frame: RefObject<HTMLDivElement | null>;
  picture: Picture;
  choice: EnhanceChoice;
  onState: (s: EnhanceState & { auto: boolean }) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<PlaybackEnhancer | null>(null);
  const settings = useEnhanceSettings();
  const onBattery = useOnBattery();
  const [state, setState] = useState<EnhanceState | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  // Levels too slow during this playback (the automatic choice steps down from them).
  const [tooSlow, setTooSlow] = useState<Level[]>([]);
  const report = useRef(onState);
  // The automatic choice measures from what was known when playback started: what this
  // playback learns is used next time (no switching up mid-episode).
  const [bench] = useState(() => readEnhance().bench);
  const autoNow = useRef(false);
  useEffect(() => {
    report.current = onState;
  });

  const wanted =
    choice === 'off' || (choice === 'settings' && settings.mode === 'off') ? false : true;
  useEffect(() => {
    const v = video.current;
    const c = canvas.current;
    if (!wanted || !v || !c || engine.current) return;
    engine.current = new PlaybackEnhancer(v, c, (s) => {
      setState(s);
      // The automatic choice steps down when the level cannot keep up.
      if (s.slow && s.level && autoNow.current)
        setTooSlow((l) => (l.includes(s.level!) ? l : [...l, s.level!]));
    });
    engine.current.probe();
  }, [wanted, video]);
  useEffect(
    () => () => {
      engine.current?.destroy();
      engine.current = null;
    },
    [],
  );

  // The video's box on screen, in device pixels.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => {
      const dpr = window.devicePixelRatio || 1;
      setBox({ w: Math.round(el.clientWidth * dpr), h: Math.round(el.clientHeight * dpr) });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame]);

  const auto = choice === 'settings' && settings.mode === 'auto';
  useEffect(() => {
    autoNow.current = auto;
  });
  const caps = state?.caps ?? null;
  const source = state?.source ?? null;
  const output = source && box && caps ? outputSize(source, box, caps.maxTexture) : null;
  let level: Level | null = null;
  if (wanted && source && output && caps) {
    if (choice !== 'settings') level = choice as Level;
    else if (settings.mode === 'manual') level = settings.manual[picture];
    else
      level = autoLevel({
        picture,
        source,
        output,
        fps: 1000 / (state?.frameMs ?? 1000 / 24),
        bench,
        handheld: isHandheld(),
        onBattery: settings.saveBattery && onBattery,
        floatTargets: caps.floatTargets,
        tooSlow,
      });
    // Anime4K needs half-float targets: the sharpening still works everywhere.
    if (level && needsFloat(level) && !caps.floatTargets) level = 'sharpen';
  }

  const style = settings.style;
  const darken = settings.darken;
  const ow = output?.w;
  const oh = output?.h;
  useEffect(() => {
    engine.current?.update({
      level: wanted ? level : null,
      options: { style, darken },
      box: ow && oh ? { w: ow, h: oh } : { w: 0, h: 0 },
    });
  }, [wanted, level, style, darken, ow, oh]);

  useEffect(() => {
    if (state) report.current({ ...state, auto });
  }, [state, auto]);

  return (
    <>
      <canvas
        ref={canvas}
        aria-hidden
        className="pointer-events-none invisible absolute inset-0 size-full object-contain"
      />
      <CueOverlay video={video} active={state?.status === 'on'} />
    </>
  );
}

/**
 * Subtitles drawn by the page while the enhanced picture covers the video (the browser draws
 * them inside the video, under the canvas). The chosen track switches to "hidden" mode: it
 * keeps loading and timing cues, and comes back to "showing" when the enhancement stops.
 */
function CueOverlay({
  video,
  active,
}: {
  video: RefObject<HTMLVideoElement | null>;
  active: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = video.current;
    const out = box.current;
    if (!el || !out || !active) return;
    const isText = (t: TextTrack) => t.kind === 'subtitles' || t.kind === 'captions';
    const tracks = () => Array.from(el.textTracks).filter(isText);
    const watched = new Set<TextTrack>();
    const draw = () => {
      const lines: Node[] = [];
      for (const t of tracks()) {
        if (t.mode !== 'hidden') continue;
        for (const cue of Array.from(t.activeCues ?? [])) {
          const line = document.createElement('div');
          const vtt = cue as VTTCue;
          if (typeof vtt.getCueAsHTML === 'function') line.append(vtt.getCueAsHTML());
          else line.textContent = (cue as { text?: string }).text ?? '';
          lines.push(line);
        }
      }
      out.replaceChildren(...lines);
    };
    const take = () => {
      for (const t of tracks()) {
        if (t.mode === 'showing') t.mode = 'hidden';
        if (!watched.has(t)) {
          watched.add(t);
          t.addEventListener('cuechange', draw);
        }
      }
      draw();
    };
    take();
    el.textTracks.addEventListener('change', take);
    el.textTracks.addEventListener('addtrack', take);
    return () => {
      el.textTracks.removeEventListener('change', take);
      el.textTracks.removeEventListener('addtrack', take);
      for (const t of watched) t.removeEventListener('cuechange', draw);
      // Back to the browser's own subtitles.
      for (const t of tracks()) if (t.mode === 'hidden') t.mode = 'showing';
      out.replaceChildren();
    };
  }, [video, active]);
  return (
    <div
      ref={box}
      aria-live="off"
      className="enhance-cues pointer-events-none absolute inset-x-0 bottom-[7%] flex flex-col items-center gap-1 px-[6%] text-center"
    />
  );
}
