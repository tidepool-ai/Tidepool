import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

/** Signed-in layout: icon rail, spaces panel and the main outlet (DESIGN-SYSTEM.md section 7). */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');

  protected readonly user = this.auth.user;

  constructor() {
    // The guard only lets signed-in users in, so losing the user means the session ended
    // (sign out here or in another tab, or a refresh that failed).
    effect(() => {
      if (!this.auth.isSignedIn()) void this.router.navigate(['/login']);
    });
  }

  /** Skip link: move focus without changing the URL (a "#main" href would resolve against <base>). */
  protected skipToMain(event: Event): void {
    event.preventDefault();
    this.main().nativeElement.focus();
  }

  protected signOut(): Promise<void> {
    return this.auth.logout();
  }
}
