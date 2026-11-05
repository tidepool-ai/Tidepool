import { ChangeDetectionStrategy, Component, effect, inject, input, untracked } from '@angular/core';
import { DatabaseStore } from './database.store';
import { DatabaseTable } from './table/table';

/** A database page's body (T17): its Table lens. Board (T18) and other views come later. */
@Component({
  selector: 'app-database-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatabaseTable],
  providers: [DatabaseStore],
  template: `
    @switch (store.status()) {
      @case ('ready') {
        <app-database-table [readOnly]="readOnly()" [label]="(title() || 'Untitled') + ' table'" />
      }
      @case ('error') {
        <p class="error" role="alert">
          Couldn't load this database.
          <button type="button" class="link-button" (click)="load()">Try again</button>
        </p>
      }
      @case ('missing') {
        <p class="error" role="alert">This database can't be found.</p>
      }
      @default {
        <p class="lead" role="status">Loading…</p>
      }
    }
  `,
  styles: `
    .lead {
      color: var(--color-muted);
    }
    .error {
      color: var(--color-danger-text);
    }
    .link-button {
      min-height: 32px;
      border: 0;
      background: none;
      color: var(--color-primary);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
  `,
})
export class DatabaseView {
  protected readonly store = inject(DatabaseStore);
  readonly pageId = input.required<string>();
  readonly workspaceId = input.required<string>();
  readonly title = input('');
  readonly readOnly = input(false);

  constructor() {
    effect(() => {
      const pageId = this.pageId();
      const workspaceId = this.workspaceId();
      untracked(() => void this.store.load(pageId, workspaceId));
    });
  }

  protected load(): void {
    void this.store.load(this.pageId(), this.workspaceId());
  }
}
