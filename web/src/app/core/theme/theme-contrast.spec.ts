import { readFileSync } from 'node:fs';
import { SCHEMES } from './theme.service';

/**
 * DESIGN-SYSTEM.md 5.7: every scheme in both modes must meet these ratios.
 * Parses the stylesheet that ships, so a new or edited scheme can't go below them unnoticed.
 */
const THEMES_FILE = 'src/styles/_themes.scss';

const TOKENS = [
  'bg', 'surface', 'text', 'muted', 'border', 'primary', 'on-primary', 'accent', 'on-accent',
  'ai', 'ai-soft', 'ai-text', 'rail', 'soft', 'soft-text',
] as const;

const PAIRS: [foreground: string, background: string, minimum: number][] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['on-primary', 'primary', 4.5],
  ['on-accent', 'accent', 4.5],
  ['ai-text', 'ai-soft', 4.5],
  ['soft-text', 'soft', 4.5],
  ['ai', 'surface', 3],
];

function parseThemes(css: string): Map<string, Record<string, string>> {
  const themes = new Map<string, Record<string, string>>();
  const block = /\[data-scheme='([\w-]+)'\]\[data-mode='(light|dark)'\]\s*\{([^}]*)\}/g;
  for (const [, scheme, mode, body] of css.matchAll(block)) {
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      tokens[name] = value;
    }
    themes.set(`${scheme}/${mode}`, tokens);
  }
  return themes;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const themes = parseThemes(readFileSync(THEMES_FILE, 'utf8'));
// Rail icons use one global color, so the rail must stay dark enough in every theme.
const onRail = readFileSync('src/styles.scss', 'utf8').match(/--color-on-rail:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? '';
const cases = SCHEMES.flatMap((scheme) => (['light', 'dark'] as const).map((mode) => `${scheme}/${mode}`));

describe('theme contrast (DESIGN-SYSTEM.md 5.7)', () => {
  it('computes WCAG ratios correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('defines exactly the 5 schemes in light and dark', () => {
    expect([...themes.keys()].sort()).toEqual([...cases].sort());
  });

  describe.each(cases)('%s', (theme) => {
    const tokens = themes.get(theme) ?? {};

    it('defines every color token', () => {
      expect(Object.keys(tokens).sort()).toEqual([...TOKENS].sort());
    });

    it('rail icons (on-rail on rail) are at least 3:1', () => {
      expect(contrastRatio(onRail, tokens['rail'])).toBeGreaterThanOrEqual(3);
    });

    it.each(PAIRS)('%s on %s is at least %s:1', (foreground, background, minimum) => {
      expect(contrastRatio(tokens[foreground], tokens[background])).toBeGreaterThanOrEqual(minimum);
    });
  });
});
