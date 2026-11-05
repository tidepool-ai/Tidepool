import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

export interface WakeOptions {
  /** Wait between health checks while the server is asleep. */
  intervalMs: number;
  /** Give up after this long. Free hosts can take about a minute to start. */
  giveUpAfterMs: number;
  /** A single health check longer than this is treated as "no answer" and retried. */
  attemptTimeoutMs: number;
  /** After a success, skip checks for this long. */
  freshForMs: number;
  /** Only show "waking up" if a check takes longer than this. */
  showAfterMs: number;
}

export const WAKE_OPTIONS = new InjectionToken<WakeOptions>('WAKE_OPTIONS', {
  factory: () => ({
    intervalMs: 3000,
    giveUpAfterMs: 90_000,
    attemptTimeoutMs: 20_000,
    freshForMs: 60_000,
    showAfterMs: 1000,
  }),
});

/** Answers that mean "nobody is home yet": no response, a proxy timeout, or a host still starting. */
function isAsleep(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) return true; // includes the attempt timing out
  return error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;
}

/**
 * Makes sure the API is awake before requests that must not be sent twice.
 *
 * On a free host the API sleeps when idle. A request sent while it starts can time out at the proxy
 * and still be handled once the API is up, so retrying it blind could rotate a refresh token twice
 * (signing the user out) or use up a sign-in link. Checking /api/health first avoids that.
 */
@Injectable({ providedIn: 'root' })
export class ServerWake {
  private readonly http = inject(HttpClient);
  private readonly options = inject(WAKE_OPTIONS);
  private awakeUntil = 0;
  private pending: Promise<boolean> | null = null;

  /** True while we're waiting for a sleeping server (shown to the user). */
  readonly waking = signal(false);

  /** True if the server answered recently, so callers can skip waiting (and stay synchronous). */
  isAwake(): boolean {
    return Date.now() < this.awakeUntil;
  }

  /** Resolves true once the server answers, or false after giving up. */
  ready(): Promise<boolean> {
    if (this.isAwake()) return Promise.resolve(true);
    this.pending ??= this.wait().finally(() => (this.pending = null));
    return this.pending;
  }

  private async wait(): Promise<boolean> {
    const { intervalMs, giveUpAfterMs, attemptTimeoutMs, freshForMs, showAfterMs } = this.options;
    const start = Date.now();
    const show = setTimeout(() => this.waking.set(true), showAfterMs);
    try {
      for (;;) {
        try {
          await firstValueFrom(this.http.get('/api/health').pipe(timeout(attemptTimeoutMs)));
          return this.awake(freshForMs);
        } catch (error) {
          // Any real answer (even an error page from the API) means the server is up.
          if (!isAsleep(error)) return this.awake(freshForMs);
        }
        this.waking.set(true);
        if (Date.now() - start + intervalMs > giveUpAfterMs) return false;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } finally {
      clearTimeout(show);
      this.waking.set(false);
    }
  }

  private awake(freshForMs: number): boolean {
    this.awakeUntil = Date.now() + freshForMs;
    return true;
  }
}

/** Thrown when the server never woke up. */
export class ServerUnavailableError extends Error {
  constructor() {
    super('The server is not responding');
  }
}
