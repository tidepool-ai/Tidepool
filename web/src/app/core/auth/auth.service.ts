import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ServerUnavailableError, ServerWake } from '../server-wake';

export interface AuthUser {
  id: string;
  email: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Magic-link sign-in against /api/auth (T02).
 * The access token lives in memory only; the refresh token is an httpOnly cookie the browser sends itself.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly wake = inject(ServerWake);
  private readonly token = signal<string | null>(null);
  private readonly currentUser = signal<AuthUser | null>(null);
  private refreshing: Promise<boolean> | null = null;
  /** Set once we know there is no session (refresh rejected, or signed out) until the next sign-in. */
  private knownSignedOut = false;

  readonly user = this.currentUser.asReadonly();
  readonly isSignedIn = computed(() => this.currentUser() !== null);

  accessToken(): string | null {
    return this.token();
  }

  /** Throws ServerUnavailableError if the server never wakes up. */
  async requestLink(email: string): Promise<void> {
    if (!this.wake.isAwake()) await this.awake();
    await firstValueFrom(this.http.post('/api/auth/magic-link', { email }));
  }

  /** Exchange the token from a magic link for a session. Throws if the link is invalid or expired. */
  async verify(linkToken: string): Promise<void> {
    // A link works once, so don't risk sending it to a server that's still starting.
    if (!this.wake.isAwake()) await this.awake();
    const response = await firstValueFrom(
      this.http.post<TokenResponse>('/api/auth/verify', { token: linkToken }),
    );
    this.knownSignedOut = false;
    this.token.set(response.access_token);
    await this.loadUser();
  }

  /** Get a new access token from the refresh cookie. Concurrent callers share one request. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.requestRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** True when signed in, restoring the session from the refresh cookie if needed (used by the guard). */
  async ensureSession(): Promise<boolean> {
    if (this.currentUser()) return true;
    if (this.knownSignedOut) return false;
    // Rotating the refresh token twice would sign the user out, so wake the server first.
    if (!this.token()) {
      if (!this.wake.isAwake() && !(await this.wake.ready())) return false;
      if (!(await this.refresh())) return false;
    }
    try {
      await this.loadUser();
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', null));
    } catch {
      // Sign out locally even if the server can't be reached.
    } finally {
      this.clear();
      this.knownSignedOut = true;
    }
  }

  private async awake(): Promise<void> {
    if (!(await this.wake.ready())) throw new ServerUnavailableError();
  }

  private async requestRefresh(): Promise<boolean> {
    try {
      const response = await firstValueFrom(this.http.post<TokenResponse>('/api/auth/refresh', null));
      this.token.set(response.access_token);
      return true;
    } catch (error) {
      this.clear();
      // A 401 means the cookie is missing, expired or revoked; network errors are worth retrying later.
      this.knownSignedOut = error instanceof HttpErrorResponse && error.status === 401;
      return false;
    }
  }

  private async loadUser(): Promise<void> {
    this.currentUser.set(await firstValueFrom(this.http.get<AuthUser>('/api/auth/me')));
  }

  private clear(): void {
    this.token.set(null);
    this.currentUser.set(null);
  }
}
