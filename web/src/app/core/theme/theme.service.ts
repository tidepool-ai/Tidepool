import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';

export const SCHEMES = ['tidepool', 'graphite', 'orchard', 'dusk', 'paper'] as const;
export const MODES = ['light', 'dark', 'system'] as const;
export const TEXT_SIZES = ['small', 'default', 'large'] as const;

export type Scheme = (typeof SCHEMES)[number];
export type Mode = (typeof MODES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type ResolvedMode = Exclude<Mode, 'system'>;

export interface Appearance {
  scheme: Scheme;
  mode: Mode;
  textSize: TextSize;
  highContrast: boolean;
}

export const DEFAULT_APPEARANCE: Readonly<Appearance> = {
  scheme: 'tidepool',
  mode: 'system',
  textSize: 'default',
  highContrast: false,
};

/** Also read by the no-flash script in index.html; keep the two in sync. */
export const APPEARANCE_STORAGE_KEY = 'tidepool.appearance';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Keeps only known values, so stale or hand-edited storage can't break the theme. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    scheme: oneOf(SCHEMES, value['scheme'], DEFAULT_APPEARANCE.scheme),
    mode: oneOf(MODES, value['mode'], DEFAULT_APPEARANCE.mode),
    textSize: oneOf(TEXT_SIZES, value['textSize'], DEFAULT_APPEARANCE.textSize),
    highContrast: value['highContrast'] === true,
  };
}

/**
 * Appearance settings (scheme, mode, text size, high contrast), applied as data-* attributes on <html>
 * and saved to localStorage. Server sync arrives with T26.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly window = this.doc.defaultView;
  private readonly media = this.window?.matchMedia?.(DARK_QUERY) ?? null;
  private readonly osDark = signal(this.media?.matches ?? false);
  private readonly state = signal<Appearance>(this.readStored());

  readonly appearance = this.state.asReadonly();
  readonly scheme = computed(() => this.state().scheme);
  readonly mode = computed(() => this.state().mode);
  readonly textSize = computed(() => this.state().textSize);
  readonly highContrast = computed(() => this.state().highContrast);
  /** The mode actually shown: "system" follows the OS and updates live when it changes. */
  readonly resolvedMode = computed<ResolvedMode>(() => {
    const mode = this.state().mode;
    if (mode !== 'system') return mode;
    return this.osDark() ? 'dark' : 'light';
  });

  constructor() {
    if (this.media) {
      const media = this.media;
      const onChange = (event: MediaQueryListEvent) => this.osDark.set(event.matches);
      media.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', onChange));
    }

    effect(() => {
      const appearance = this.state();
      const root = this.doc.documentElement;
      root.dataset['scheme'] = appearance.scheme;
      root.dataset['mode'] = this.resolvedMode();
      root.dataset['textSize'] = appearance.textSize;
      root.dataset['contrast'] = appearance.highContrast ? 'high' : 'normal';
      this.store(appearance);
    });
  }

  setScheme(scheme: Scheme): void {
    this.update({ scheme });
  }

  setMode(mode: Mode): void {
    this.update({ mode });
  }

  setTextSize(textSize: TextSize): void {
    this.update({ textSize });
  }

  setHighContrast(highContrast: boolean): void {
    this.update({ highContrast });
  }

  update(patch: Partial<Appearance>): void {
    // Animate user-initiated changes only (see .theme-transition in styles.scss).
    this.doc.documentElement.classList.add('theme-transition');
    this.state.update((current) => sanitizeAppearance({ ...current, ...patch }));
  }

  private readStored(): Appearance {
    try {
      const raw = this.window?.localStorage.getItem(APPEARANCE_STORAGE_KEY);
      return sanitizeAppearance(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

  private store(appearance: Appearance): void {
    try {
      this.window?.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // Storage can be unavailable (private mode, quota); the theme still applies for this visit.
    }
  }
}
