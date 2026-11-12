import { evalRpn, fragmentSource, parseHooks, readsOf } from './hooks';
import type { Size } from './levels';

/**
 * What a chain of mpv passes does for a picture of `source` size shown at `output`: the passes
 * that run (conditions evaluated), their sizes, and which texture each reads and writes.
 * Textures are "slots": slot 0 is the video frame; a pass writes into a slot of its size that
 * no later pass will read again, so a 40-pass chain needs a handful of textures. Pure (no GPU).
 */
export interface PlanStep {
  desc: string;
  fs: string;
  size: Size;
  /** Texture names the pass reads, and the slot holding each. */
  reads: { name: string; slot: number }[];
  /** Texture name written (MAIN unless the pass saves under its own name), and its slot. */
  writes: string;
  target: number;
}
export interface Plan {
  steps: PlanStep[];
  slots: Size[];
  /** The slot holding the final picture. */
  final: number;
}

export class PlanError extends Error {
  constructor(
    readonly reason: 'size' | 'shader',
    message: string,
  ) {
    super(message);
  }
}

export function planChain(chain: string[], source: Size, output: Size, maxTexture: number): Plan {
  const hooks = chain.flatMap(parseHooks);
  // mpv runs PREKERNEL hooks after every MAIN hook (Anime4K's highlight clamp relies on it).
  const ordered = [
    ...hooks.filter((p) => p.hook === 'MAIN'),
    ...hooks.filter((p) => p.hook === 'PREKERNEL'),
  ];
  const sizes = new Map<string, Size>([['MAIN', source]]);
  const sizeOf = (ref: string) => {
    const [name, dim] = ref.split('.');
    const s = name === 'OUTPUT' ? output : name === 'NATIVE' ? source : sizes.get(name);
    if (!s) throw new PlanError('shader', `Unknown texture ${name}`);
    return dim === 'w' ? s.w : s.h;
  };
  const passes: { desc: string; fs: string; size: Size; reads: string[]; writes: string }[] = [];
  for (const pass of ordered) {
    if (pass.when && evalRpn(pass.when, sizeOf) === 0) continue;
    const main = sizes.get('MAIN')!;
    const size = {
      w: Math.round(pass.width ? evalRpn(pass.width, sizeOf) : main.w),
      h: Math.round(pass.height ? evalRpn(pass.height, sizeOf) : main.h),
    };
    if (size.w > maxTexture || size.h > maxTexture || size.w < 1 || size.h < 1)
      throw new PlanError('size', 'Picture too large for this GPU');
    const reads = readsOf(pass);
    for (const r of reads) if (!sizes.has(r)) throw new PlanError('shader', `Unknown texture ${r}`);
    const writes = pass.save ?? 'MAIN';
    passes.push({ desc: pass.desc, fs: fragmentSource(pass), size, reads, writes });
    sizes.set(writes, size);
  }

  const slots: Size[] = [source];
  const named = new Map<string, number>([['MAIN', 0]]);
  const free: number[] = [];
  const steps: PlanStep[] = [];
  for (const [i, pass] of passes.entries()) {
    const reads = pass.reads.map((name) => ({ name, slot: named.get(name)! }));
    const inputs = new Set(reads.map((r) => r.slot));
    const at = free.findIndex(
      (s) => slots[s].w === pass.size.w && slots[s].h === pass.size.h && !inputs.has(s),
    );
    const target = at >= 0 ? free.splice(at, 1)[0] : slots.push(pass.size) - 1;
    steps.push({
      desc: pass.desc,
      fs: pass.fs,
      size: pass.size,
      reads,
      writes: pass.writes,
      target,
    });
    named.set(pass.writes, target);
    // A name stays alive while a later pass reads it before anything writes it again (Anime4K's
    // networks reuse names: the upscale's conv2d_tf is not the restore's). Slots of dead names
    // are free (never slot 0: the frame is uploaded into it).
    const alive = new Set<number>();
    for (const [name, slot] of named) {
      if (name === 'MAIN' || readBeforeWrite(passes, i + 1, name)) alive.add(slot);
      else named.delete(name);
    }
    for (const slot of new Set([...inputs, target]))
      if (slot !== 0 && !alive.has(slot) && !free.includes(slot)) free.push(slot);
  }
  return { steps, slots, final: named.get('MAIN')! };
}

/** Some pass from `from` on reads `name` before any pass writes it. */
function readBeforeWrite(
  passes: { reads: string[]; writes: string }[],
  from: number,
  name: string,
) {
  for (let j = from; j < passes.length; j++) {
    if (passes[j].reads.includes(name)) return true;
    if (passes[j].writes === name) return false;
  }
  return false;
}
