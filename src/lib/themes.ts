/**
 * Interface themes. A theme only changes how the same interface looks (colours, type, shapes,
 * navigation style), never what it contains: every page, dialog and control stays the same.
 * The choice belongs to the device, like the interface language.
 */
export const THEMES = [
  { id: 'bunko', tones: ['default'], light: false },
  { id: 'cine', tones: ['night'], light: false },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export interface ThemeChoice {
  theme: ThemeId;
  tone: string;
}

/** Swatches shown in the picker: background, then accent. Mirrors the tokens in globals.css. */
export const TONE_SWATCHES: Record<string, [string, string]> = {
  default: ['#0b0a09', '#e2dbd0'],
  night: ['#070b10', '#ffffff'],
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
