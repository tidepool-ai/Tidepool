import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { rememberReturnUrl } from '../../core/auth/return-url';
import { ServerUnavailableError } from '../../core/server-wake';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function loginErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse && error.status === 422) {
    return "That email address doesn't look right. Check it and try again.";
  }
  if (error instanceof ServerUnavailableError || (error instanceof HttpErrorResponse && [0, 502, 503, 504].includes(error.status))) {
    return "The server isn't responding. Try again in a minute.";
  }
  return "We couldn't send the link. Try again in a moment.";
}

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-card.scss',
  template: `
    <main id="main" class="auth" tabindex="-1">
      <section class="card" aria-labelledby="login-title">
        <h1 id="login-title">Sign in to Tidepool</h1>
        @if (status() === 'sent') {
          <p class="lead" role="status">
            Check <strong>{{ email() }}</strong> for a sign-in link. It works once and expires in 15 minutes.
          </p>
          <button type="button" class="secondary" (click)="status.set('idle')">Use a different email</button>
        } @else {
          <p class="lead">We'll email you a link that signs you in. No password needed.</p>
          <form (submit)="send($event)">
            <label for="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="email"
              required
              [value]="email()"
              (input)="email.set($any($event.target).value)"
              [attr.aria-describedby]="status() === 'error' ? 'login-error' : null"
            />
            @if (status() === 'error') {
              <p id="login-error" class="error" role="alert">{{ errorMessage() }}</p>
            }
            <button type="submit" class="primary" [disabled]="status() === 'sending'">
              {{ status() === 'sending' ? 'Sending…' : 'Send sign-in link' }}
            </button>

          </form>
        }
      </section>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);

  /** Set by the auth guard (?returnUrl=…). */
  readonly returnUrl = input<string>();
  protected readonly email = signal('');
  protected readonly status = signal<Status>('idle');
  protected readonly errorMessage = signal('');

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.email().trim();
    if (!email || this.status() === 'sending') return;
    this.status.set('sending');
    try {
      rememberReturnUrl(this.returnUrl() ?? null);
      await this.auth.requestLink(email);
      this.status.set('sent');
    } catch (error) {
      this.errorMessage.set(loginErrorMessage(error));
      this.status.set('error');
    }
  }
}
