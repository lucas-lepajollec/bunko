/**
 * Interface themes. A theme only changes how the same interface looks (colours, type, shapes,
 * navigation style), never what it contains: every page, dialog and control stays the same.
 * The choice belongs to the device, like the interface language.
 */
export const THEMES = [
  { id: 'cine', tones: ['night'], light: false },
  { id: 'bunko', tones: ['default'], light: false },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export interface ThemeChoice {
  theme: ThemeId;
  tone: string;
}

/** Swatches shown in the picker: background, then accent. Mirrors the tokens in globals.css. */
export const TONE_SWATCHES: Record<string, [string, string]> = {
  night: ['#070b10', '#ffffff'],
  default: ['#0b0a09', '#e2dbd0'],
};

export const THEME_KEY = 'bunko.theme';
export const DEFAULT_THEME: ThemeChoice = { theme: 'cine', tone: 'night' };

export function normalizeTheme(value: unknown): ThemeChoice {
  const v = (value ?? {}) as Partial<ThemeChoice>;
  const theme = THEMES.find((t) => t.id === v.theme);
  if (!theme) return DEFAULT_THEME;
  const tones: readonly string[] = theme.tones;
  return { theme: theme.id, tone: tones.includes(v.tone ?? '') ? v.tone! : tones[0] };
}

/** JSON safe inside an inline <script>: no `</script>`, `<!--` or line separators can end it. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

/**
 * Runs before the first paint (inline in the document head) so a page never flashes the other
 * look. Kept dependency-free and in sync with `normalizeTheme` / `applyTheme`.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=JSON.parse(localStorage.getItem('${THEME_KEY}')||'null');var T=${scriptJson(
  Object.fromEntries(THEMES.map((t) => [t.id, t.tones])),
)};var S=${scriptJson(
  Object.fromEntries(THEMES.map((t) => [t.id, t.light ? 'light' : 'dark'])),
)};var id=c&&T[c.theme]?c.theme:'${DEFAULT_THEME.theme}';var tone=c&&T[id].indexOf(c.tone)>=0?c.tone:T[id][0];var d=document.documentElement;if(id==='bunko'){delete d.dataset.theme;delete d.dataset.tone;}else{d.dataset.theme=id;d.dataset.tone=tone;}d.style.colorScheme=S[id];}catch(e){}})();`;
