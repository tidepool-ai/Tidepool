import {
  ChangeDetectionStrategy,
  Component,
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
import { PagePage } from '../../page/page.page';
import { DatabaseStore } from '../database.store';

/**
 * A database row open beside its table or board (FR-17, T19): the row's page (title, properties,
 * live editor) in a side panel, with "Open as full page". Esc or Close closes it.
 */
@Component({
  selector: 'app-row-peek',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PagePage],
  templateUrl: './row-peek.html',
  styleUrl: './row-peek.scss',
})
export class RowPeek {
  protected readonly store = inject(DatabaseStore);
  readonly rowId = input.required<string>();
  readonly closed = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly injector = inject(Injector);
  protected readonly title = computed(() => this.store.rows().find((r) => r.id === this.rowId())?.title || 'Untitled');

  constructor() {
    // Move focus into the panel whenever a row opens in it, so screen readers announce it.
    effect(() => {
      this.rowId();
      afterNextRender(() => this.panel().nativeElement.focus(), { injector: this.injector });
    });
  }

  protected titleSaved(event: { id: string; title: string }): void {
    this.store.applyTitle(event.id, event.title);
  }
}
