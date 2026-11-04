import { readFileSync } from 'node:fs';
import { APPEARANCE_STORAGE_KEY } from './theme.service';

/** Runs the inline <head> script from index.html, which sets the theme before Angular boots. */
function runNoFlashScript(): void {
  const html = readFileSync('src/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('no inline script in index.html');
  new Function(script)();
}

const root = () => document.documentElement;

describe('index.html no-flash script', () => {
  let osDark = false;

  beforeEach(() => {
    osDark = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: osDark }),
    });
    localStorage.clear();
    for (const name of ['scheme', 'mode', 'textSize', 'contrast']) delete root().dataset[name];
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('applies defaults when nothing is saved, following the OS', () => {
    osDark = true;
    runNoFlashScript();
    expect(root().dataset).toMatchObject({ scheme: 'tidepool', mode: 'dark', textSize: 'default', contrast: 'normal' });
  });

  it('applies saved settings', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ scheme: 'paper', mode: 'light', textSize: 'small', highContrast: true }),
    );
    osDark = true;
    runNoFlashScript();
    expect(root().dataset).toMatchObject({ scheme: 'paper', mode: 'light', textSize: 'small', contrast: 'high' });
  });

  it('falls back to defaults for unknown or broken values', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ scheme: 'neon', textSize: 'huge' }));
    runNoFlashScript();
    expect(root().dataset).toMatchObject({ scheme: 'tidepool', mode: 'light', textSize: 'default' });

    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json');
    runNoFlashScript();
    expect(root().dataset['scheme']).toBe('tidepool');
  });
});
