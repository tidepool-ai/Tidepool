import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ServerWake } from './core/server-wake';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: `
    @if (wake.waking()) {
      <p class="wake-notice" role="status">Waking up the server. This can take up to a minute.</p>
    }
    <router-outlet />
  `,
  styles: `
    .wake-notice {
      position: fixed;
      inset: 12px 12px auto;
      z-index: 20;
      width: fit-content;
      max-width: calc(100% - 24px);
      margin: 0 auto;
      padding: 10px 16px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pill, 999px);
      background: var(--color-surface);
      color: var(--color-text);
      box-shadow: 0 10px 24px color-mix(in srgb, var(--color-rail) 18%, transparent);
    }
  `,
})
export class App {
  protected readonly wake = inject(ServerWake);
}
