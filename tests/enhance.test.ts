import { describe, expect, it } from 'vitest';
import { evalRpn, fragmentSource, parseHooks } from '@/lib/client/enhance/hooks';
import {
  LADDER,
  LEVELS,
  autoLevel,
  chainFiles,
  expectedMs,
  loadChain,
  lowerLevel,
  needsFloat,
  outputSize,
  type Level,
  type Size,
  type Style,
} from '@/lib/client/enhance/levels';
import { planChain } from '@/lib/client/enhance/plan';

const P720: Size = { w: 1280, h: 720 };
const P1080: Size = { w: 1920, h: 1080 };
const P480: Size = { w: 854, h: 480 };
const MAX = 16384;

/**
 * Walks a plan the way the GPU runs it and checks that every texture a pass reads still holds
 * what was last written under that name (slot reuse never overwrites a value still needed).
 */
function checkPlan(plan: ReturnType<typeof planChain>) {
  const holds = new Map<number, string>([[0, 'MAIN@source']]);
  const names = new Map<string, string>([['MAIN', 'MAIN@source']]);
  plan.steps.forEach((step, i) => {
    for (const r of step.reads) expect(holds.get(r.slot)).toBe(names.get(r.name));
    expect(step.reads.map((r) => r.slot)).not.toContain(step.target);
    expect(step.target).not.toBe(0);
    expect(plan.slots[step.target]).toEqual(step.size);
    const value = `${step.writes}@${i}`;
    holds.set(step.target, value);
    names.set(step.writes, value);
  });
  expect(holds.get(plan.final)).toBe(names.get('MAIN'));
}

describe('mpv hook shaders', () => {
  it('parses passes, directives and bodies', () => {
    const passes = parseHooks(`// licence
//!DESC first
//!HOOK MAIN
//!BIND HOOKED
//!SAVE A
//!WIDTH MAIN.w 2 *
vec4 hook() { return HOOKED_tex(HOOKED_pos); }
//!DESC second
//!HOOK PREKERNEL
//!BIND HOOKED
//!BIND A
//!WHEN OUTPUT.w MAIN.w / 1.2 >
vec4 hook() { return A_texOff(vec2(1, 0)); }
`);
    expect(passes).toHaveLength(2);
    expect(passes[0]).toMatchObject({ desc: 'first', save: 'A', width: ['MAIN.w', '2', '*'] });
    expect(passes[1]).toMatchObject({ hook: 'PREKERNEL', binds: ['HOOKED', 'A'] });
    expect(passes[1].body).toContain('A_texOff');
    const fs = fragmentSource(passes[1]);
    expect(fs).toContain('uniform sampler2D A_raw;');
    expect(fs).toContain('uniform sampler2D MAIN_raw;');
    expect(fs).toContain('#define HOOKED_tex(pos) texture(MAIN_raw, (pos))');
    expect(fs.startsWith('#version 300 es')).toBe(true);
  });

  it('evaluates mpv expressions', () => {
    const size = (ref: string) => ({ 'OUTPUT.w': 2560, 'MAIN.w': 1280, 'MAIN.h': 720 })[ref]!;
    expect(evalRpn('OUTPUT.w MAIN.w / 1.200 >'.split(' '), size)).toBe(1);
    expect(evalRpn('MAIN.w 2 *'.split(' '), size)).toBe(2560);
    expect(evalRpn('MAIN.h 1 + !'.split(' '), size)).toBe(0);
    expect(() => evalRpn(['+'], size)).toThrow();
  });
});

describe('enhancement chains', () => {
  const styles: Style[] = ['A', 'B', 'C'];
  it('loads every level and style and plans it at common sizes', async () => {
    for (const level of LEVELS)
      for (const style of needsFloat(level) ? styles : (['A'] as const))
        for (const darken of needsFloat(level) ? [false, true] : [false]) {
          const chain = await loadChain(level, { style, darken });
          expect(chain).toHaveLength(chainFiles(level, { style, darken }).length);
          for (const [source, output] of [
            [P720, { w: 2560, h: 1440 }],
            [P1080, P1080],
            [P480, { w: 3840, h: 2160 }],
          ] as const) {
            const plan = planChain(chain, source, output, MAX);
            expect(plan.steps.length).toBeGreaterThan(0);
            checkPlan(plan);
          }
        }
  });

  it('upscales only when the screen is larger, twice for small videos on large screens', async () => {
    const chain = await loadChain('a4k-m', { style: 'A', darken: false });
    const final = (source: Size, output: Size) => {
      const plan = planChain(chain, source, output, MAX);
      return plan.slots[plan.final];
    };
    expect(final(P1080, P1080)).toEqual(P1080);
    expect(final(P720, { w: 2560, h: 1440 })).toEqual({ w: 2560, h: 1440 });
    expect(final(P480, { w: 3840, h: 2160 })).toEqual({ w: 854 * 4, h: 480 * 4 });
    const fsr = await loadChain('fsr', { style: 'A', darken: false });
    const out = planChain(fsr, P720, { w: 1920, h: 1080 }, MAX);
    expect(out.slots[out.final]).toEqual({ w: 1920, h: 1080 });
    expect(out.steps).toHaveLength(2);
    expect(planChain(fsr, P1080, P1080, MAX).steps).toHaveLength(1);
  });

  it('shares textures between passes that are never alive together', async () => {
    const chain = await loadChain('a4k-vl', { style: 'A', darken: false });
    const plan = planChain(chain, P1080, { w: 3840, h: 2160 }, MAX);
    expect(plan.steps.length).toBeGreaterThan(30);
    expect(plan.slots.length).toBeLessThan(plan.steps.length * 0.7);
  });

  it('refuses sizes beyond the GPU limit', async () => {
    const chain = await loadChain('a4k-s', { style: 'A', darken: false });
    expect(() => planChain(chain, P1080, { w: 3840, h: 2160 }, 2048)).toThrow(/too large/);
  });
});

describe('automatic level', () => {
  const base = {
    source: P1080,
    output: { w: 3840, h: 2160 },
    fps: 24,
    handheld: false,
    onBattery: false,
    floatTargets: true,
  };
  it('picks the richest level that fits the frame budget', () => {
    const bench = { sharpen: 0.5, 'a4k-s': 2, 'a4k-m': 4, 'a4k-vl': 12 };
    // 1080p is 2.25× the measured 720p: VL ≈ 27 ms > 18.75 ms budget at 24 fps, M ≈ 9 ms fits.
    expect(autoLevel({ ...base, picture: 'drawn', bench })).toBe('a4k-m');
    expect(autoLevel({ ...base, picture: 'drawn', bench, fps: 60 })).toBe('a4k-s');
    expect(autoLevel({ ...base, picture: 'drawn', bench, source: P480 })).toBe('a4k-vl');
  });
  it('tries the next level when far within budget, never on battery', () => {
    expect(autoLevel({ ...base, picture: 'drawn', bench: { sharpen: 0.3, 'a4k-s': 1 } })).toBe(
      'a4k-m',
    );
    expect(autoLevel({ ...base, picture: 'drawn', bench: { 'a4k-m': 2 }, onBattery: true })).toBe(
      'sharpen',
    );
  });
  it('defaults cautiously before any measurement', () => {
    expect(autoLevel({ ...base, picture: 'drawn', bench: {} })).toBe('a4k-s');
    expect(autoLevel({ ...base, picture: 'filmed', bench: {} })).toBe('fsr');
    expect(autoLevel({ ...base, picture: 'drawn', bench: {}, handheld: true })).toBe('sharpen');
    expect(autoLevel({ ...base, picture: 'drawn', bench: {}, floatTargets: false })).toBe(
      'sharpen',
    );
  });
  it('steps down from levels that proved too slow', () => {
    expect(autoLevel({ ...base, picture: 'drawn', bench: {}, tooSlow: ['a4k-s'] })).toBe('sharpen');
    expect(lowerLevel('drawn', 'a4k-vl')).toBe('a4k-m');
    expect(lowerLevel('filmed', 'sharpen')).toBeNull();
  });
  it('scales costs with the work each level does', () => {
    const bench: Partial<Record<Level, number>> = { fsr: 2, 'a4k-m': 4 };
    expect(expectedMs('a4k-m', bench, P1080, P1080)).toBeCloseTo(9);
    expect(expectedMs('fsr', bench, P720, { w: 1280, h: 720 })).toBeCloseTo(0.5);
    expect(expectedMs('a4k-vl', bench, P1080, P1080)).toBeNull();
  });
  it('keeps every ladder inside the known levels', () => {
    for (const ladder of Object.values(LADDER)) for (const l of ladder) expect(LEVELS).toContain(l);
  });
});

describe('output size', () => {
  it('fits the screen, never below the video, capped at 4K and the GPU limit', () => {
    expect(outputSize(P720, { w: 2560, h: 1600 }, MAX)).toEqual({ w: 2560, h: 1440 });
    expect(outputSize(P1080, { w: 1280, h: 720 }, MAX)).toEqual(P1080);
    const big = outputSize(P480, { w: 7680, h: 4320 }, MAX);
    expect(big.w * big.h).toBeLessThanOrEqual(3840 * 2160);
    expect(big.w).toBeGreaterThan(3800);
    expect(outputSize(P720, { w: 3840, h: 2160 }, 2048).w).toBeLessThanOrEqual(2048);
  });
});
