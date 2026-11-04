import { TestBed } from '@angular/core/testing';
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, ThemeService } from './theme.service';

/** A controllable stand-in for matchMedia('(prefers-color-scheme: dark)'). */
class FakeDarkQuery {
  private listeners = new Set<(event: MediaQueryListEvent) => void>();
  constructor(public matches: boolean) {}
  addEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  osSwitchesTo(dark: boolean): void {
    this.matches = dark;
    this.listeners.forEach((listener) => listener({ matches: dark } as MediaQueryListEvent));
  }
}

const root = () => document.documentElement;
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null');

describe('ThemeService', () => {
  let osQuery: FakeDarkQuery;

  function createService(): ThemeService {
    const service = TestBed.inject(ThemeService);
    TestBed.tick();
    return service;
  }

  beforeEach(() => {
    osQuery = new FakeDarkQuery(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => osQuery),
    });
    localStorage.clear();
    for (const name of ['scheme', 'mode', 'textSize', 'contrast']) delete root().dataset[name];
    root().classList.remove('theme-transition');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('starts with Tidepool, System mode, default text and normal contrast', () => {
    const service = createService();

    expect(service.appearance()).toEqual(DEFAULT_APPEARANCE);
    expect(root().dataset).toMatchObject({
      scheme: 'tidepool',
      mode: 'light',
      textSize: 'default',
      contrast: 'normal',
    });
    expect(root().classList).not.toContain('theme-transition');
  });

  it('applies and saves each color scheme', () => {
    const service = createService();

    for (const scheme of ['graphite', 'orchard', 'dusk', 'paper', 'tidepool'] as const) {
      service.setScheme(scheme);
      TestBed.tick();
      expect(root().dataset['scheme']).toBe(scheme);
      expect(stored().scheme).toBe(scheme);
    }
  });

  it('applies and saves light and dark mode, ignoring the OS', () => {
    osQuery.matches = true;
    const service = createService();

    service.setMode('light');
    TestBed.tick();
    expect(root().dataset['mode']).toBe('light');
    expect(stored().mode).toBe('light');

    osQuery.osSwitchesTo(false);
    service.setMode('dark');
    TestBed.tick();
    expect(root().dataset['mode']).toBe('dark');
    expect(service.resolvedMode()).toBe('dark');
    expect(stored().mode).toBe('dark');
  });

  it('follows the OS in system mode and updates live when it switches', () => {
    osQuery.matches = true;
    const service = createService();
    expect(root().dataset['mode']).toBe('dark');

    osQuery.osSwitchesTo(false);
    TestBed.tick();
    expect(service.resolvedMode()).toBe('light');
    expect(root().dataset['mode']).toBe('light');

    osQuery.osSwitchesTo(true);
    TestBed.tick();
    expect(root().dataset['mode']).toBe('dark');
    // The saved choice stays "system"; only what is shown changes.
    expect(stored().mode).toBe('system');
  });

  it('stops following the OS after leaving system mode and resumes when it returns', () => {
    const service = createService();
    service.setMode('light');
    osQuery.osSwitchesTo(true);
    TestBed.tick();
    expect(root().dataset['mode']).toBe('light');

    service.setMode('system');
    TestBed.tick();
    expect(root().dataset['mode']).toBe('dark');
  });

  it('applies and saves each text size', () => {
    const service = createService();

    for (const size of ['small', 'large', 'default'] as const) {
      service.setTextSize(size);
      TestBed.tick();
      expect(root().dataset['textSize']).toBe(size);
      expect(stored().textSize).toBe(size);
    }
  });

  it('applies and saves high contrast', () => {
    const service = createService();

    service.setHighContrast(true);
    TestBed.tick();
    expect(root().dataset['contrast']).toBe('high');
    expect(stored().highContrast).toBe(true);

    service.setHighContrast(false);
    TestBed.tick();
    expect(root().dataset['contrast']).toBe('normal');
    expect(stored().highContrast).toBe(false);
  });

  it('restores saved settings on start', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ scheme: 'dusk', mode: 'dark', textSize: 'large', highContrast: true }),
    );
    const service = createService();

    expect(service.appearance()).toEqual({
      scheme: 'dusk',
      mode: 'dark',
      textSize: 'large',
      highContrast: true,
    });
    expect(root().dataset).toMatchObject({ scheme: 'dusk', mode: 'dark', textSize: 'large', contrast: 'high' });
  });

  it('ignores unknown or broken saved values', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ scheme: 'neon', mode: 'dim', textSize: 99, highContrast: 'yes' }),
    );
    expect(createService().appearance()).toEqual(DEFAULT_APPEARANCE);

    TestBed.resetTestingModule();
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json');
    expect(createService().appearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps working when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const service = createService();

    service.setScheme('orchard');
    TestBed.tick();
    expect(root().dataset['scheme']).toBe('orchard');
    vi.restoreAllMocks();
  });

  it('works without matchMedia, treating the OS as light', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    const service = createService();
    expect(service.resolvedMode()).toBe('light');
  });

  it('animates user changes only', () => {
    const service = createService();
    expect(root().classList).not.toContain('theme-transition');
    service.setScheme('paper');
    expect(root().classList).toContain('theme-transition');
  });

  it('stops listening to the OS when destroyed', () => {
    createService();
    expect(osQuery.listenerCount).toBe(1);
    TestBed.resetTestingModule();
    expect(osQuery.listenerCount).toBe(0);
  });
});
