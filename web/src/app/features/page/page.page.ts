import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Placeholder for /p/:pageId until the editor (T08). */
@Component({
  selector: 'app-page-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../page-header.scss',
  template: `
    <h1>Untitled</h1>
    <p class="lead">Page {{ pageId() }}. The editor arrives in a later task.</p>
  `,
})
export class PagePage {
  readonly pageId = input.required<string>();
}
