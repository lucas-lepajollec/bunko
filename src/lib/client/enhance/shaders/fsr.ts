/**
 * AMD FidelityFX Super Resolution 1 for filmed pictures, written as mpv passes so one engine
 * runs everything: EASU (edge-adaptive upscale to the screen's size, skipped when the video is
 * not enlarged) then RCAS (contrast-adaptive sharpening). A port of the 32-bit paths of
 * ffx_fsr1.h, https://github.com/GPUOpen-Effects/FidelityFX-FSR:
 *
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or substantial portions of
 * the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

export const EASU = `//!DESC FSR1-EASU
//!HOOK MAIN
//!BIND HOOKED
//!WIDTH OUTPUT.w
//!HEIGHT OUTPUT.h
//!WHEN OUTPUT.w MAIN.w / 1.05 > OUTPUT.h MAIN.h / 1.05 > +
vec3 easuLoad(ivec2 p) {
  return texelFetch(HOOKED_raw, clamp(p, ivec2(0), ivec2(HOOKED_size) - 1), 0).rgb;
}
float easuLuma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }
void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x) * len;
  float d2 = min(dot(v, v), clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}
void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-5);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-5);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}
vec4 hook() {
  vec2 pp = floor(gl_FragCoord.xy) * (HOOKED_size / target_size) + (0.5 * HOOKED_size / target_size - 0.5);
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 f = ivec2(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 b = easuLoad(f + ivec2(0, -1)), c = easuLoad(f + ivec2(1, -1));
  vec3 e = easuLoad(f + ivec2(-1, 0)), F = easuLoad(f), g = easuLoad(f + ivec2(1, 0)), h = easuLoad(f + ivec2(2, 0));
  vec3 i = easuLoad(f + ivec2(-1, 1)), j = easuLoad(f + ivec2(0, 1)), k = easuLoad(f + ivec2(1, 1)), l = easuLoad(f + ivec2(2, 1));
  vec3 n = easuLoad(f + ivec2(0, 2)), o = easuLoad(f + ivec2(1, 2));
  float bL = easuLuma(b), cL = easuLuma(c), eL = easuLuma(e), fL = easuLuma(F), gL = easuLuma(g);
  float hL = easuLuma(h), iL = easuLuma(i), jL = easuLuma(j), kL = easuLuma(k), lL = easuLuma(l);
  float nL = easuLuma(n), oL = easuLuma(o);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);
  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 min4 = min(min(F, g), min(j, k));
  vec3 max4 = max(max(F, g), max(j, k));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  easuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  easuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  easuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  easuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, F);
  easuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  easuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  easuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  easuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  easuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  easuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  easuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  return vec4(min(max4, max(min4, aC / aW)), 1.0);
}
`;

/** RCAS at the picture's own size; `stops` lowers the strength (0 = strongest). */
export const rcas = (stops: number) => `//!DESC FSR1-RCAS
//!HOOK MAIN
//!BIND HOOKED
#define RCAS_SHARPNESS ${Math.pow(2, -stops).toFixed(4)}
#define RCAS_LIMIT (0.25 - (1.0 / 16.0))
vec3 rcasLoad(ivec2 p) {
  return texelFetch(HOOKED_raw, clamp(p, ivec2(0), ivec2(HOOKED_size) - 1), 0).rgb;
}
vec4 hook() {
  ivec2 sp = ivec2(gl_FragCoord.xy);
  vec3 b = rcasLoad(sp + ivec2(0, -1));
  vec3 d = rcasLoad(sp + ivec2(-1, 0));
  vec3 e = rcasLoad(sp);
  vec3 f = rcasLoad(sp + ivec2(1, 0));
  vec3 h = rcasLoad(sp + ivec2(0, 1));
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * RCAS_SHARPNESS;
  // Noise detection (FSR_RCAS_DENOISE): grain and compression noise are not sharpened.
  float bL = b.b * 0.5 + (b.r * 0.5 + b.g), dL = d.b * 0.5 + (d.r * 0.5 + d.g);
  float eL = e.b * 0.5 + (e.r * 0.5 + e.g), fL = f.b * 0.5 + (f.r * 0.5 + f.g);
  float hL = h.b * 0.5 + (h.r * 0.5 + h.g);
  float nz = 0.25 * (bL + dL + fL + hL) - eL;
  float range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = clamp(abs(nz) / max(range, 1e-5), 0.0, 1.0);
  lobe *= -0.5 * nz + 1.0;
  return vec4((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 1.0);
}
`;
