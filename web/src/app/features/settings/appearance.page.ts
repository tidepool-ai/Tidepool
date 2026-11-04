import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder for Settings › Appearance until T26. */
@Component({
  selector: 'app-appearance-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../page-header.scss',
  template: `
    <h1>Appearance</h1>
    <p class="lead">Color scheme, mode, text size and contrast controls arrive in a later task.</p>
  `,
})
export class AppearancePage {}
