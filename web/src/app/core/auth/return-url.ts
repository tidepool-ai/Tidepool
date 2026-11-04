import { safeReturnUrl } from './auth.guard';

const KEY = 'tidepool.returnUrl';

/** Remember where to go after sign-in. The magic link usually opens in a new tab, so use localStorage. */
export function rememberReturnUrl(url: string | null): void {
  try {
    if (url) localStorage.setItem(KEY, safeReturnUrl(url));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: fall back to /home after sign-in.
  }
}

export function takeReturnUrl(): string {
  try {
    const url = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    return safeReturnUrl(url);
  } catch {
    return '/home';
  }
}
