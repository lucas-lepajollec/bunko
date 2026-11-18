/**
 * Interface themes. A theme only changes how the same interface looks (colours, type, shapes,
 * navigation style), never what it contains: every page, dialog and control stays the same.
 * The choice belongs to the device, like the interface language.
 */
export const THEMES = [
  { id: 'bunko', tones: ['default'], light: false },
  { id: 'cine', tones: ['glacier', 'braise', 'jade'], light: false },
  { id: 'aurore', tones: ['ambre', 'ocean', 'rose'], light: false },
  { id: 'edition', tones: ['creme', 'craie', 'lin'], light: true },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export interface ThemeChoice {
  theme: ThemeId;
  tone: string;
}

/** Swatches shown in the picker: background, then accent. Mirrors the tokens in globals.css. */
export const TONE_SWATCHES: Record<string, [string, string]> = {
  default: ['#0b0a09', '#e2dbd0'],
  glacier: ['#070b10', '#8fd3ff'],
  braise: ['#0f0907', '#ffb54d'],
  jade: ['#060f0c', '#5be3a8'],
  ambre: ['#1a1410', '#ffcf8a'],
  ocean: ['#0b1420', '#9fd8ff'],
  rose: ['#1c1016', '#ffb3c8'],
  creme: ['#f4f1ea', '#c8361f'],
  craie: ['#eef1f4', '#1f4fd1'],
  lin: ['#efe8da', '#2f6b4a'],
};

export const THEME_KEY = 'bunko.theme';
const DEFAULT: ThemeChoice = { theme: 'bunko', tone: 'default' };

export function normalizeTheme(value: unknown): ThemeChoice {
  const v = (value ?? {}) as Partial<ThemeChoice>;
  const theme = THEMES.find((t) => t.id === v.theme);
  if (!theme) return DEFAULT;
  const tones: readonly string[] = theme.tones;
  return { theme: theme.id, tone: tones.includes(v.tone ?? '') ? v.tone! : tones[0] };
}

/**
 * Runs before the first paint (inline in the document head) so a page never flashes the default
 * look. Kept dependency-free and in sync with `normalizeTheme` / `applyTheme`.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=JSON.parse(localStorage.getItem('${THEME_KEY}')||'null');var T=${JSON.stringify(
  Object.fromEntries(THEMES.map((t) => [t.id, t.tones])),
)};if(!c||!T[c.theme])return;var tone=T[c.theme].indexOf(c.tone)>=0?c.tone:T[c.theme][0];var d=document.documentElement;d.dataset.theme=c.theme;d.dataset.tone=tone;d.style.colorScheme=${JSON.stringify(
  Object.fromEntries(THEMES.map((t) => [t.id, t.light ? 'light' : 'dark'])),
)}[c.theme];}catch(e){}})();`;
