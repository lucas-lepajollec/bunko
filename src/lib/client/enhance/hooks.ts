/**
 * mpv "user shaders" (the format Anime4K ships in, documented in mpv's `--glsl-shaders`): a
 * file holds passes, each a few `//!` directives and a body defining `vec4 hook()`. Only what
 * an RGB picture needs is supported: passes hooking MAIN (and PREKERNEL, which runs after them),
 * named textures (BIND / SAVE), sizes and conditions in mpv's reverse Polish notation.
 */
export interface HookPass {
  desc: string;
  hook: string;
  /** Textures the body reads; HOOKED is the hooked one (MAIN here). */
  binds: string[];
  /** Texture written; null overwrites the hooked one. */
  save: string | null;
  width: string[] | null;
  height: string[] | null;
  /** The pass runs only when this evaluates to non-zero. */
  when: string[] | null;
  body: string;
}

export function parseHooks(source: string): HookPass[] {
  const passes: HookPass[] = [];
  let pass: HookPass | null = null;
  // A pass starts at its first directive after a body (or at the top of the file).
  let inBody = true;
  for (const line of source.split(/\r?\n/)) {
    const m = /^\/\/!(\w+)\s*(.*)$/.exec(line);
    if (!m) {
      if (pass) pass.body += `${line}\n`;
      inBody = true;
      continue;
    }
    if (inBody) {
      pass = {
        desc: '',
        hook: 'MAIN',
        binds: [],
        save: null,
        width: null,
        height: null,
        when: null,
        body: '',
      };
      passes.push(pass);
      inBody = false;
    }
    const [, key, raw] = m;
    const value = raw.trim();
    if (key === 'DESC') pass!.desc = value;
    else if (key === 'HOOK') pass!.hook = value;
    else if (key === 'BIND') pass!.binds.push(value);
    else if (key === 'SAVE') pass!.save = value;
    else if (key === 'WIDTH') pass!.width = value.split(/\s+/);
    else if (key === 'HEIGHT') pass!.height = value.split(/\s+/);
    else if (key === 'WHEN') pass!.when = value.split(/\s+/);
    // COMPONENTS, OFFSET…: every texture here is RGBA at its natural place.
  }
  return passes;
}

/** Evaluates an mpv size or condition (`OUTPUT.w MAIN.w / 1.2 >`); `size` gives `NAME.w|h`. */
export function evalRpn(tokens: string[], size: (ref: string) => number): number {
  const stack: number[] = [];
  const pop = () => {
    const v = stack.pop();
    if (v === undefined) throw new Error(`Malformed expression: ${tokens.join(' ')}`);
    return v;
  };
  for (const token of tokens) {
    if (/^-?\d*\.?\d+(e-?\d+)?$/i.test(token)) stack.push(Number(token));
    else if (/^\w+\.[wh]$/.test(token)) stack.push(size(token));
    else if (token === '!') stack.push(pop() === 0 ? 1 : 0);
    else {
      const b = pop();
      const a = pop();
      if (token === '+') stack.push(a + b);
      else if (token === '-') stack.push(a - b);
      else if (token === '*') stack.push(a * b);
      else if (token === '/') stack.push(a / b);
      else if (token === '>') stack.push(a > b ? 1 : 0);
      else if (token === '<') stack.push(a < b ? 1 : 0);
      else if (token === '=') stack.push(a === b ? 1 : 0);
      else throw new Error(`Unknown operator ${token}`);
    }
  }
  const result = pop();
  if (stack.length) throw new Error(`Malformed expression: ${tokens.join(' ')}`);
  return result;
}

/** The textures a pass reads, HOOKED resolved to MAIN (always read: it is the hooked one). */
export const readsOf = (pass: HookPass) => [
  ...new Set(['MAIN', ...pass.binds.map((b) => (b === 'HOOKED' ? 'MAIN' : b))]),
];

/**
 * A GLSL ES 3.00 fragment shader for a pass: mpv's helpers for each texture it reads
 * (NAME_raw, NAME_size, NAME_pt, NAME_pos, NAME_tex, NAME_texOff, and HOOKED_* for MAIN) plus
 * `target_size`, the size being written.
 */
export function fragmentSource(pass: HookPass): string {
  let src =
    '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n' +
    'in vec2 v_uv;\nout vec4 bunko_out;\nuniform vec2 target_size;\n';
  const define = (alias: string, name: string) =>
    `#define ${alias}_raw ${name}_raw\n#define ${alias}_size ${name}_size\n` +
    `#define ${alias}_pt (1.0 / ${name}_size)\n#define ${alias}_pos v_uv\n` +
    `#define ${alias}_tex(pos) texture(${name}_raw, (pos))\n` +
    `#define ${alias}_texOff(off) texture(${name}_raw, v_uv + (1.0 / ${name}_size) * vec2(off))\n`;
  for (const name of readsOf(pass)) {
    src += `uniform sampler2D ${name}_raw;\nuniform vec2 ${name}_size;\n`;
    src += define(name, name).replace(/^#define (\w+)_raw \1_raw\n#define \1_size \1_size\n/, '');
  }
  src += define('HOOKED', 'MAIN');
  return `${src}#line 1\n${pass.body}\nvoid main() { bunko_out = hook(); }\n`;
}
