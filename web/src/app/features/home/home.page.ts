import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';

/** Placeholder until the Today view (AI digest, my tasks, recent pages) lands. */
@Component({
  selector: 'app-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../page-header.scss',
  template: `
    <h1>Home</h1>
    <p class="lead">Signed in as {{ user()?.email }}. Your pages and tasks will show up here.</p>
  `,
})
export class HomePage {
  protected readonly user = inject(AuthService).user;
}
