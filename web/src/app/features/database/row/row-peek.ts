import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatabaseStore } from '../database.store';

/**
 * A database row open beside its table or board (FR-17, T19): a side panel around the row's page
 * (projected in by the page view: title, properties, live editor), with "Open as full page" and Close.
 */
@Component({
  selector: 'app-row-peek',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './row-peek.html',
  styleUrl: './row-peek.scss',
})
export class RowPeek {
  private readonly store = inject(DatabaseStore);
  readonly rowId = input.required<string>();
  readonly closed = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly injector = inject(Injector);
  protected readonly title = computed(() => this.store.rows().find((r) => r.id === this.rowId())?.title || 'Untitled');

  constructor() {
    // Esc closes the peek, unless a menu or list inside it is open (the slash menu, a block menu):
    // then that gets the key. Checked before anything handles it, while those are still showing.
    // (The editor marks every Esc as handled, so "already handled" can't tell.)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const panel = this.panel().nativeElement;
      if (panel.querySelector('[role="menu"], [role="listbox"], .panel, .cell.editing')) return;
      this.closed.emit();
    };
    afterNextRender(() => this.panel().nativeElement.addEventListener('keydown', escape, true));
    inject(DestroyRef).onDestroy(() => this.panel().nativeElement.removeEventListener('keydown', escape, true));

    // Move focus into the panel whenever a row opens in it, so screen readers announce it.
    effect(() => {
      this.rowId();
      afterNextRender(() => this.panel().nativeElement.focus(), { injector: this.injector });
    });
  }
}
