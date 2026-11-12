'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from '@/components/select';
import { Switch } from '@/components/work-settings';
import { Segmented, cx, smallButton } from '@/components/ui';
import { isHandheld } from '@/components/video-enhance';
import { degradedScene, runBench, type BenchProgress } from '@/lib/client/enhance/bench';
import {
  BUDGET_SHARE,
  LADDER,
  LEVELS,
  autoLevel,
  expectedMs,
  loadChain,
  needsFloat,
  outputSize,
  type ChainOptions,
  type Level,
  type Picture,
  type Size,
} from '@/lib/client/enhance/levels';
import { Enhancer, type Capabilities } from '@/lib/client/enhance/renderer';
import { updateEnhance, useEnhanceSettings } from '@/lib/client/enhance/settings';

/**
 * Settings › Playback: picture enhancement for this device. Everything runs and stays in the
 * browser (the GPU's measurements included); the server is never involved.
 */
const RESOLUTIONS: { label: string; size: Size }[] = [
  { label: '480p', size: { w: 854, h: 480 } },
  { label: '720p', size: { w: 1280, h: 720 } },
  { label: '1080p', size: { w: 1920, h: 1080 } },
];
const card = 'flex flex-col gap-4 rounded-[18px] bg-white/[0.045] p-4 text-sm md:p-[22px]';

/** The screen in device pixels ("1920x1080"), following moves between screens and zoom. */
function useScreen(): Size | null {
  const key = useSyncExternalStore(
    (l) => {
      window.addEventListener('resize', l);
      return () => window.removeEventListener('resize', l);
    },
    () => {
      const dpr = window.devicePixelRatio || 1;
      return `${Math.round(screen.width * dpr)}x${Math.round(screen.height * dpr)}`;
    },
    () => '',
  );
  if (!key) return null;
  const [w, h] = key.split('x').map(Number);
  return { w, h };
}

/** What this browser's GPU offers, read once with a throwaway context. */
let probed: Capabilities | 'none' | undefined;
function probeCaps() {
  if (probed === undefined) {
    try {
      const engine = new Enhancer(document.createElement('canvas'));
      probed = engine.caps;
      engine.destroy();
    } catch {
      probed = 'none';
    }
  }
  return probed;
}
const useCaps = () =>
  useSyncExternalStore<Capabilities | 'none' | null>(
    () => () => undefined,
    probeCaps,
    () => null,
  );

export function EnhanceSettings() {
  const { t } = useI18n();
  const s = useEnhanceSettings();
  const caps = useCaps();
  const usable = (l: Level) => caps !== 'none' && (!needsFloat(l) || !caps || caps.floatTargets);
  const levelOptions = (picture: Picture) => [
    { value: 'none', label: t('enhance.off') },
    ...[...LADDER[picture], ...LEVELS.filter((l) => !LADDER[picture].includes(l))]
      .filter(usable)
      .map((l) => ({ value: l, label: t(`enhance.level.${l}`) })),
  ];
  const options: ChainOptions = { style: s.style, darken: s.darken };
  return (
    <div className="flex flex-col gap-5">
      <p className="text-mid leading-relaxed">{t('enhance.intro')}</p>
      {caps === 'none' && (
        <p className="text-warn rounded-xl bg-white/[0.04] p-3">{t('enhance.noWebgl')}</p>
      )}

      <div className={card}>
        <Segmented
          label={t('enhance.title')}
          value={s.mode}
          onChange={(mode) => updateEnhance({ mode })}
          items={[
            { id: 'auto', label: t('enhance.mode.auto') },
            { id: 'manual', label: t('enhance.mode.manual') },
            { id: 'off', label: t('enhance.mode.off') },
          ]}
        />
        <p className="text-muted text-xs leading-relaxed">{t(`enhance.modeHint.${s.mode}`)}</p>
        {s.mode === 'manual' &&
          (['drawn', 'filmed'] as const).map((p) => (
            <div key={p} className="flex items-center justify-between gap-4">
              <span>{t(`enhance.picture.${p}`)}</span>
              <Select
                label={t(`enhance.picture.${p}`)}
                value={s.manual[p] ?? 'none'}
                options={levelOptions(p)}
                onChange={(v) =>
                  updateEnhance({
                    manual: { ...s.manual, [p]: v === 'none' ? null : (v as Level) },
                  })
                }
                className="w-56"
              />
            </div>
          ))}
        {s.mode !== 'off' && (
          <>
            <div className="flex items-center justify-between gap-4">
              <span className="flex flex-col gap-0.5">
                <span>{t('enhance.style')}</span>
                <span className="text-muted text-xs">{t('enhance.styleHint')}</span>
              </span>
              <Select
                label={t('enhance.style')}
                value={s.style}
                options={(['A', 'B', 'C'] as const).map((v) => ({
                  value: v,
                  label: t(`enhance.styles.${v}`),
                }))}
                onChange={(v) => updateEnhance({ style: v as 'A' | 'B' | 'C' })}
                className="w-56"
              />
            </div>
            <Toggle
              label={t('enhance.darken')}
              hint={t('enhance.darkenHint')}
              checked={s.darken}
              onChange={(darken) => updateEnhance({ darken })}
            />
            <Toggle
              label={t('enhance.battery')}
              hint={t('enhance.batteryHint')}
              checked={s.saveBattery}
              onChange={(saveBattery) => updateEnhance({ saveBattery })}
            />
          </>
        )}
      </div>

      {caps !== 'none' && <Bench caps={caps} options={options} />}
      {caps !== 'none' && <Compare caps={caps} options={options} usable={usable} />}
      <p className="text-muted text-xs leading-relaxed">{t('enhance.credits')}</p>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-muted text-xs">{hint}</span>
      </span>
      <Switch checked={checked} label={label} onChange={onChange} />
    </div>
  );
}

/** The device: what it supports, what each level costs on it, what "Auto" picks. */
function Bench({ caps, options }: { caps: Capabilities | null; options: ChainOptions }) {
  const { t, language } = useI18n();
  const s = useEnhanceSettings();
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Level, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const display = useScreen();
  const run = async () => {
    abort.current = new AbortController();
    setErrors({});
    setFailure(null);
    try {
      const result = await runBench(options, setProgress, abort.current.signal);
      if (abort.current.signal.aborted) return;
      updateEnhance({ bench: result.bench, benchAt: new Date().toISOString() });
      setErrors(result.errors);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  const fps = 24;
  const budget = (1000 / fps) * BUDGET_SHARE;
  const measured = LEVELS.filter((l) => s.bench[l] !== undefined);
  const autoFor = (picture: Picture, size: Size) => {
    if (!caps || !display) return null;
    return autoLevel({
      picture,
      source: size,
      output: outputSize(size, display, caps.maxTexture),
      fps,
      bench: s.bench,
      handheld: isHandheld(),
      onBattery: false,
      floatTargets: caps.floatTargets,
    });
  };
  return (
    <div className={card}>
      <h3 className="text-[17px] font-semibold">{t('enhance.device')}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{t('enhance.gpu')}</dt>
        <dd className="truncate">{caps?.gpu ?? t('enhance.unknown')}</dd>
        <dt className="text-muted">{t('enhance.screen')}</dt>
        <dd className="tabular-nums">{display ? `${display.w} × ${display.h}` : '—'}</dd>
        <dt className="text-muted">Anime4K</dt>
        <dd>
          {caps ? (caps.floatTargets ? t('enhance.supported') : t('enhance.notSupported')) : '—'}
        </dd>
        <dt className="text-muted">{t('enhance.compile')}</dt>
        <dd>
          {caps
            ? caps.parallelCompile
              ? t('enhance.compileBackground')
              : t('enhance.compileBlocking')
            : '—'}
        </dd>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={smallButton}
          disabled={Boolean(progress) || !caps}
          onClick={() => void run()}
        >
          {progress
            ? t('enhance.measuring', {
                level: t(`enhance.level.${progress.level}`),
                done: progress.done + 1,
                total: progress.total,
              })
            : s.benchAt
              ? t('enhance.measureAgain')
              : t('enhance.measure')}
        </button>
        {measured.length > 0 && !progress && (
          <button
            type="button"
            className="text-mid text-[13px] hover:text-white"
            onClick={() => updateEnhance({ bench: {}, benchAt: null })}
          >
            {t('enhance.forget')}
          </button>
        )}
        {s.benchAt && (
          <span className="text-muted text-xs">
            {t('enhance.measuredOn', {
              date: new Date(s.benchAt).toLocaleDateString(language),
            })}
          </span>
        )}
      </div>
      <p className="text-muted text-xs leading-relaxed">{t('enhance.measureHint')}</p>
      {failure && <p className="text-warn text-xs">{`${t('enhance.failed')} (${failure})`}</p>}

      {measured.length > 0 && display && caps && (
        <div className="flex flex-col overflow-hidden rounded-2xl bg-white/[0.04]">
          {LEVELS.filter((l) => !needsFloat(l) || caps.floatTargets).map((l) => (
            <div
              key={l}
              className="border-line flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2.5 last:border-b-0"
            >
              <span className="min-w-40 flex-1">{t(`enhance.level.${l}`)}</span>
              <span className="text-muted w-32 text-xs whitespace-nowrap tabular-nums">
                {s.bench[l] !== undefined
                  ? t('enhance.msPerFrame', { ms: s.bench[l]!.toFixed(1) })
                  : errors[l]
                    ? t('enhance.failed')
                    : '—'}
              </span>
              <span className="flex gap-1.5">
                {RESOLUTIONS.map((r) => {
                  const ms = expectedMs(
                    l,
                    s.bench,
                    r.size,
                    outputSize(r.size, display, caps.maxTexture),
                  );
                  const ok = ms !== null && ms <= budget;
                  return (
                    <span
                      key={r.label}
                      title={
                        ms !== null ? t('enhance.msPerFrame', { ms: ms.toFixed(1) }) : undefined
                      }
                      className={cx(
                        'rounded-full px-2 py-0.5 text-[11px] tabular-nums',
                        ms === null
                          ? 'text-muted bg-white/[0.04]'
                          : ok
                            ? 'bg-emerald-400/15 text-emerald-200'
                            : 'bg-white/[0.06] text-white/40 line-through',
                      )}
                    >
                      {r.label}
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      )}
      {measured.length > 0 && <p className="text-muted text-xs">{t('enhance.fluidHint')}</p>}

      {caps && display && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted text-xs tracking-[0.08em] uppercase">
            {t('enhance.autoPicks')}
          </span>
          {(['drawn', 'filmed'] as const).map((p) => (
            <div key={p} className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <span className="w-full md:w-auto md:min-w-36">{t(`enhance.picture.${p}`)}</span>
              {RESOLUTIONS.map((r) => {
                const l = autoFor(p, r.size);
                return (
                  <span key={r.label} className="text-mid">
                    {r.label} → {l ? t(`enhance.level.${l}`) : t('enhance.off')}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Before / after on the test picture or a file of this device (an image or a video, read
 * locally: nothing is uploaded).
 */
function Compare({
  caps,
  options,
  usable,
}: {
  caps: Capabilities | null;
  options: ChainOptions;
  usable: (l: Level) => boolean;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLCanvasElement>(null);
  const after = useRef<HTMLCanvasElement>(null);
  const fileVideo = useRef<HTMLVideoElement>(null);
  const engine = useRef<Enhancer | null>(null);
  const [chosen, setLevel] = useState<Level>('a4k-m');
  const level: Level = usable(chosen) ? chosen : 'sharpen';
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(false);
  const [input, setInput] = useState<
    | { kind: 'image'; image: ImageBitmap | HTMLCanvasElement; name: string | null }
    | { kind: 'video'; url: string; name: string }
    | null
  >(null);
  const [width, setWidth] = useState(0);
  // A video's size is known once it has loaded.
  const [videoSize, setVideoSize] = useState<Size | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void degradedScene().then((image) => {
      if (live) setInput((i) => i ?? { kind: 'image', image, name: null });
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = after.current;
    if (!c) return;
    try {
      engine.current = new Enhancer(c);
    } catch {
      engine.current = null;
    }
    return () => {
      engine.current?.destroy();
      engine.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      if (input?.kind === 'video') URL.revokeObjectURL(input.url);
    },
    [input],
  );

  // The current frame of the input: the picture itself, or the file video's.
  const frameOf = (): TexImageSource | null =>
    input?.kind === 'image' ? input.image : input?.kind === 'video' ? fileVideo.current : null;

  const sw = input?.kind === 'image' ? input.image.width : (videoSize?.w ?? 0);
  const sh = input?.kind === 'image' ? input.image.height : (videoSize?.h ?? 0);
  const source: Size | null = sw && sh ? { w: sw, h: sh } : null;

  const style = options.style;
  const darken = options.darken;
  useEffect(() => {
    const e = engine.current;
    const b = before.current;
    const fileEl = fileVideo.current;
    if (!e || !b || !sw || !sh || !width || !caps) return;
    const source = { w: sw, h: sh };
    let live = true;
    let request: number | null = null;
    const dpr = window.devicePixelRatio || 1;
    const shown = {
      w: Math.round(width * dpr),
      h: Math.round((width * dpr * source.h) / source.w),
    };
    const out = outputSize(source, shown, caps.maxTexture);
    setError(null);
    setMs(null);
    const drawBefore = (frame: TexImageSource) => {
      if (b.width !== out.w || b.height !== out.h) {
        b.width = out.w;
        b.height = out.h;
      }
      const ctx = b.getContext('2d')!;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(frame as CanvasImageSource, 0, 0, out.w, out.h);
    };
    void (async () => {
      try {
        await e.configure(
          await loadChain(level, { style, darken }),
          source,
          out,
          needsFloat(level),
        );
        if (!live) return;
        const frame = frameOf();
        if (!frame) return;
        drawBefore(frame);
        setMs(e.time(frame, 3));
        const v = fileVideo.current as
          (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
        if (input?.kind === 'video' && v?.requestVideoFrameCallback) {
          const tick = () => {
            if (!live) return;
            e.draw(v);
            drawBefore(v);
            request = v.requestVideoFrameCallback!(tick);
          };
          request = v.requestVideoFrameCallback(tick);
        }
      } catch (err) {
        if (live && !(err instanceof DOMException && err.name === 'AbortError'))
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
      if (request !== null)
        (
          fileEl as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void }
        )?.cancelVideoFrameCallback?.(request);
    };
    // frameOf reads the current input; the input is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, style, darken, sw, sh, width, caps, input]);

  // Zoom ×2 on the middle, where the details are.
  const zoomed = zoom ? { transform: 'scale(2)' } : undefined;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setVideoSize(null);
    if (file.type.startsWith('video/'))
      return setInput({ kind: 'video', url: URL.createObjectURL(file), name: file.name });
    try {
      const bitmap = await createImageBitmap(file);
      // Very large photos are reduced to what a video would carry.
      const max = 1920;
      if (bitmap.width <= max && bitmap.height <= max)
        return setInput({ kind: 'image', image: bitmap, name: file.name });
      const k = Math.min(max / bitmap.width, max / bitmap.height);
      const c = document.createElement('canvas');
      c.width = Math.round(bitmap.width * k);
      c.height = Math.round(bitmap.height * k);
      c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      setInput({ kind: 'image', image: c, name: file.name });
    } catch {
      setError(t('enhance.badFile'));
    }
  };

  return (
    <div className={card}>
      <h3 className="text-[17px] font-semibold">{t('enhance.compare')}</h3>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          label={t('enhance.title')}
          value={level}
          options={LEVELS.filter(usable).map((l) => ({ value: l, label: t(`enhance.level.${l}`) }))}
          onChange={(v) => setLevel(v as Level)}
          className="w-56"
        />
        <label className={cx(smallButton, 'cursor-pointer')}>
          {t('enhance.useFile')}
          <input
            type="file"
            accept="image/*,video/*"
            className="sr-only"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </label>
        <button
          type="button"
          aria-pressed={zoom}
          className={cx(smallButton, zoom && 'bg-fg text-bg hover:bg-fg')}
          onClick={() => setZoom((z) => !z)}
        >
          {t('enhance.zoom')}
        </button>
        {input?.name && (
          <button
            type="button"
            className="text-mid text-[13px] hover:text-white"
            onClick={() =>
              void degradedScene().then((image) => setInput({ kind: 'image', image, name: null }))
            }
          >
            {t('enhance.useTestPicture')}
          </button>
        )}
      </div>
      <div
        ref={box}
        className="relative w-full overflow-hidden rounded-xl bg-black"
        style={{ aspectRatio: source ? `${source.w} / ${source.h}` : '16 / 9' }}
      >
        {input?.kind === 'video' && (
          <video
            ref={fileVideo}
            src={input.url}
            muted
            loop
            autoPlay
            playsInline
            className="absolute inset-0 size-full opacity-0"
            onLoadedData={(e) =>
              setVideoSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
            }
          />
        )}
        <canvas
          ref={before}
          className="absolute inset-0 size-full"
          aria-label={t('enhance.before')}
          style={zoomed}
        />
        {/* Clipped by a wrapper: the canvas itself may be scaled by the zoom. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          <canvas
            ref={after}
            className="absolute inset-0 size-full"
            aria-label={t('enhance.after')}
            style={zoomed}
          />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80"
          style={{ left: `${split}%` }}
        />
        <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px]">
          {t('enhance.before')}
        </span>
        <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px]">
          {t('enhance.after')}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label={t('enhance.split')}
        className="accent-fg w-full"
      />
      <p className="text-muted text-xs tabular-nums">
        {error
          ? `${t('enhance.failed')} (${error})`
          : source
            ? `${source.w} × ${source.h}${ms !== null ? ` · ${t('enhance.msPerFrame', { ms: ms.toFixed(1) })}` : ''}`
            : t('enhance.preparing')}
        {!input?.name && ` · ${t('enhance.testPictureHint')}`}
      </p>
    </div>
  );
}
