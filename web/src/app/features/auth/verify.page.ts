import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { takeReturnUrl } from '../../core/auth/return-url';

/** Target of the emailed magic link: /auth/verify?token=… */
@Component({
  selector: 'app-verify-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styleUrl: './auth-card.scss',
  template: `
    <main id="main" class="auth" tabindex="-1">
      <section class="card" aria-labelledby="verify-title">
        @if (failed()) {
          <h1 id="verify-title">This link doesn't work</h1>
          <p class="lead" role="alert">Sign-in links work once and expire after 15 minutes.</p>
          <a class="primary" routerLink="/login">Get a new link</a>
        } @else {
          <h1 id="verify-title">Signing you in…</h1>
          <p class="lead" role="status">One moment.</p>
        }
      </section>
    </main>
  `,
})
export class VerifyPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly token = input<string>();
  protected readonly failed = signal(false);

  async ngOnInit(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.failed.set(true);
      return;
    }
    try {
      await this.auth.verify(token);
      await this.router.navigateByUrl(takeReturnUrl(), { replaceUrl: true });
    } catch {
      this.failed.set(true);
    }
  }
}
