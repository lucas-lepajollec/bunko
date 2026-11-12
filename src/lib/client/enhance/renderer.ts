import { PlanError, planChain, type Plan } from './plan';
import type { Size } from './levels';

/**
 * Runs a chain of mpv passes on a picture with WebGL2, in the viewer's browser: the server only
 * ever sent the video. One engine per canvas; programs are kept across reconfigurations (a new
 * size or a resize only reallocates textures), intermediate textures are shared between passes
 * that are never alive together.
 */
export interface Capabilities {
  /** Half-float render targets (Anime4K's networks need them). */
  floatTargets: boolean;
  maxTexture: number;
  /** Shaders compile off the main thread (KHR_parallel_shader_compile). */
  parallelCompile: boolean;
  gpu: string | null;
}

interface Texture {
  tex: WebGLTexture;
  w: number;
  h: number;
  half: boolean;
}
interface Step {
  program: WebGLProgram;
  inputs: {
    tex: Texture;
    sampler: WebGLUniformLocation | null;
    size: WebGLUniformLocation | null;
  }[];
  target: Texture;
  fbo: WebGLFramebuffer;
  targetSize: WebGLUniformLocation | null;
}

export class EnhanceError extends Error {
  constructor(
    readonly reason: 'webgl' | 'float' | 'size' | 'shader' | 'lost' | 'blocked',
    message: string,
  ) {
    super(message);
  }
}

const VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  // One triangle covering the target; uv (0,0) is texel row 0 of every texture.
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  v_uv = p * 0.5 + 0.5;
}`;
const PRESENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 bunko_out;
uniform sampler2D picture;
void main() { bunko_out = vec4(clamp(texture(picture, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 0.0, 1.0), 1.0); }`;

export class Enhancer {
  readonly caps: Capabilities;
  private readonly gl: WebGL2RenderingContext;
  private readonly vertex: WebGLShader;
  private readonly programs = new Map<string, WebGLProgram>();
  private present: WebGLProgram | null = null;
  private steps: Step[] = [];
  private textures: Texture[] = [];
  private source: Texture | null = null;
  private final: Texture | null = null;
  private readonly vao: WebGLVertexArrayObject;
  private readonly pixel = new Uint8Array(4);
  private lost = false;
  private destroyed = false;
  /** Bumped by each configure(): a slower earlier one never overwrites a newer setup. */
  private generation = 0;
  onLost: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // Kept: a paused video's frame must survive the page recomposing (Safari blanks it).
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new EnhanceError('webgl', 'WebGL2 unavailable');
    this.gl = gl;
    const float =
      Boolean(gl.getExtension('EXT_color_buffer_float')) ||
      Boolean(gl.getExtension('EXT_color_buffer_half_float'));
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    let gpu: string | null = null;
    try {
      gpu = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
    } catch {
      gpu = null;
    }
    this.caps = {
      floatTargets: float && this.halfFloatRenderable(),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      parallelCompile: Boolean(gl.getExtension('KHR_parallel_shader_compile')),
      gpu,
    };
    this.vertex = this.shader(gl.VERTEX_SHADER, VERTEX);
    this.vao = gl.createVertexArray()!;
    canvas.addEventListener('webglcontextlost', this.contextLost as EventListener);
  }

  private contextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.onLost?.();
  };

  /** Some drivers advertise the extension yet refuse the framebuffer: try one. */
  private halfFloatRenderable() {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  }

  private shader(type: number, source: string) {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  }

  /**
   * Compiles what is missing. With KHR_parallel_shader_compile the driver works in the
   * background and this polls; without it each program blocks, so they are spread over frames
   * (playback goes on meanwhile, the plain video showing).
   */
  private async compile(sources: string[], stale: () => boolean) {
    const gl = this.gl;
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const fresh: { source: string; program: WebGLProgram; fs: WebGLShader }[] = [];
    for (const source of new Set(sources)) {
      if (this.programs.has(source)) continue;
      const fs = this.shader(gl.FRAGMENT_SHADER, source);
      const program = gl.createProgram()!;
      gl.attachShader(program, this.vertex);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      fresh.push({ source, program, fs });
      if (!parallel) await new Promise((r) => setTimeout(r, 0));
      if (stale()) break;
    }
    if (parallel)
      while (
        !stale() &&
        fresh.some((f) => !gl.getProgramParameter(f.program, parallel.COMPLETION_STATUS_KHR))
      )
        await new Promise((r) => setTimeout(r, 16));
    for (const f of fresh) {
      if (stale() || this.lost) {
        gl.deleteProgram(f.program);
        gl.deleteShader(f.fs);
        continue;
      }
      if (!gl.getProgramParameter(f.program, gl.LINK_STATUS)) {
        const log = gl.getShaderInfoLog(f.fs) || gl.getProgramInfoLog(f.program);
        gl.deleteProgram(f.program);
        gl.deleteShader(f.fs);
        throw new EnhanceError('shader', `Shader failed: ${log?.slice(0, 300)}`);
      }
      gl.detachShader(f.program, f.fs);
      gl.deleteShader(f.fs);
      this.programs.set(f.source, f.program);
    }
  }

  private texture(w: number, h: number, half: boolean): Texture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, half ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const t = { tex, w, h, half };
    this.textures.push(t);
    return t;
  }

  /** Frees the textures (the GPU memory) and keeps the compiled programs for a later setup. */
  release() {
    if (this.gl.isContextLost()) return;
    const gl = this.gl;
    for (const s of this.steps) gl.deleteFramebuffer(s.fbo);
    for (const t of this.textures) gl.deleteTexture(t.tex);
    this.steps = [];
    this.textures = [];
    this.source = null;
    this.final = null;
  }

  /** GPU memory held by the textures of the current setup. */
  get textureBytes() {
    return this.textures.reduce((n, t) => n + t.w * t.h * (t.half ? 8 : 4), 0);
  }
  get passes() {
    return this.steps.length;
  }
  /** Size of the picture drawn (the canvas). */
  get drawnSize(): Size | null {
    return this.final ? { w: this.final.w, h: this.final.h } : null;
  }

  /**
   * Prepares a chain for a picture of `source` size shown at `output` (device pixels). Resolves
   * once every program is ready; a later call supersedes an unfinished one (AbortError).
   */
  async configure(chain: string[], source: Size, output: Size, half: boolean) {
    if (this.destroyed || this.lost) throw new EnhanceError('lost', 'GPU context lost');
    const generation = ++this.generation;
    const stale = () => generation !== this.generation || this.destroyed;
    const gl = this.gl;
    if (half && !this.caps.floatTargets)
      throw new EnhanceError('float', 'No half-float render targets');
    const max = this.caps.maxTexture;
    if (source.w > max || source.h > max) throw new EnhanceError('size', 'Video too large');

    let plan: Plan;
    try {
      plan = planChain(chain, source, output, max);
    } catch (e) {
      if (e instanceof PlanError) throw new EnhanceError(e.reason, e.message);
      throw e;
    }

    await this.compile([...plan.steps.map((p) => p.fs), PRESENT], stale);
    if (stale()) throw new DOMException('Superseded', 'AbortError');
    if (this.lost) throw new EnhanceError('lost', 'GPU context lost');
    this.present = this.programs.get(PRESENT)!;

    this.release();
    const textures = plan.slots.map((size, i) =>
      this.texture(size.w, size.h, i === 0 ? false : half),
    );
    this.source = textures[0];
    for (const step of plan.steps) {
      const target = textures[step.target];
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        throw new EnhanceError('float', 'Render target refused');
      }
      const program = this.programs.get(step.fs)!;
      this.steps.push({
        program,
        fbo,
        target,
        targetSize: gl.getUniformLocation(program, 'target_size'),
        inputs: step.reads.map((r) => ({
          tex: textures[r.slot],
          sampler: gl.getUniformLocation(program, `${r.name}_raw`),
          size: gl.getUniformLocation(program, `${r.name}_size`),
        })),
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.final = textures[plan.final];
    this.canvas.width = this.final.w;
    this.canvas.height = this.final.h;
  }

  /**
   * Draws one frame. Throws EnhanceError('blocked') when the browser forbids reading the
   * video's pixels (a stream from another site without CORS).
   */
  draw(frame: TexImageSource) {
    if (!this.final || !this.source || !this.present || this.lost || this.destroyed) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source.tex);
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError')
        throw new EnhanceError('blocked', 'Cross-origin video');
      throw e;
    }
    for (const s of this.steps) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.viewport(0, 0, s.target.w, s.target.h);
      gl.useProgram(s.program);
      s.inputs.forEach((input, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, input.tex.tex);
        gl.uniform1i(input.sampler, unit);
        gl.uniform2f(input.size, input.tex.w, input.tex.h);
      });
      gl.uniform2f(s.targetSize, s.target.w, s.target.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.final.w, this.final.h);
    gl.useProgram(this.present);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.final.tex);
    gl.uniform1i(gl.getUniformLocation(this.present, 'picture'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Waits for the GPU to finish what was drawn; returns the time it took. */
  sync() {
    const t0 = performance.now();
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel);
    return performance.now() - t0;
  }

  /** Draws `frames` frames and returns the average time per frame, GPU work included. */
  time(frame: TexImageSource, frames: number) {
    this.draw(frame);
    this.sync();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) this.draw(frame);
    this.sync();
    return (performance.now() - t0) / frames;
  }

  /** The current picture read back (tests and comparisons), RGBA rows from the top. */
  readPicture(): ImageData | null {
    if (!this.final) return null;
    const { w, h } = this.final;
    const gl = this.gl;
    const data = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // The canvas's row 0 is its bottom: flip into image order.
    const row = w * 4;
    const tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < h / 2; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      tmp.set(data.subarray(a, a + row));
      data.copyWithin(a, b, b + row);
      data.set(tmp, b);
    }
    return new ImageData(data, w, h);
  }

  get isLost() {
    return this.lost || this.gl.isContextLost();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.canvas.removeEventListener('webglcontextlost', this.contextLost as EventListener);
    if (this.gl.isContextLost()) return;
    this.release();
    for (const p of this.programs.values()) this.gl.deleteProgram(p);
    this.programs.clear();
    this.gl.deleteShader(this.vertex);
    this.gl.deleteVertexArray(this.vao);
    // Frees the GPU memory now rather than whenever the canvas is collected.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
