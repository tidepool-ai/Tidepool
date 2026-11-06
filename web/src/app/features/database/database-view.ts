import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map, of } from 'rxjs';
import { RowPeek } from './row/row-peek';
import { DatabaseBoard } from './board/board';
import { Row } from './database.api';
import { DatabaseStore } from './database.store';
import { DatabaseTable } from './table/table';

/** A database page's body: its views as tabs, and the active one (Table, T17, or Board, T18). */
@Component({
  selector: 'app-database-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatabaseTable, DatabaseBoard, RowPeek],
  providers: [DatabaseStore],
  templateUrl: './database-view.html',
  styleUrl: './database-view.scss',
  host: { '(document:mousedown)': 'closeMenuOutside($event)', '(document:keydown.escape)': 'escape($event)' },
})
export class DatabaseView {
  protected readonly store = inject(DatabaseStore);
  readonly pageId = input.required<string>();
  readonly workspaceId = input.required<string>();
  readonly title = input('');
  readonly readOnly = input(false);

  protected readonly adding = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router, { optional: true });
  private readonly route = inject(ActivatedRoute, { optional: true });
  /** The row open in the side peek: `?row=<id>` in the URL, so it can be linked and reloaded. */
  protected readonly openRowId = toSignal(this.route?.queryParamMap.pipe(map((params) => params.get('row'))) ?? of(null), {
    initialValue: null,
  });
  /** Where focus was when the row opened, to return to on close. */
  private opener: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const pageId = this.pageId();
      const workspaceId = this.workspaceId();
      untracked(() => void this.store.load(pageId, workspaceId));
    });
  }

  /** A row changed in the peek: show it in the table or board. */
  applyRow(row: Row): void {
    this.store.applyRow(row);
  }

  applyTitle(event: { id: string; title: string }): void {
    this.store.applyTitle(event.id, event.title);
  }

  /** Open a row in the side peek. */
  protected openRow(rowId: string): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void this.router?.navigate([], { relativeTo: this.route, queryParams: { row: rowId }, queryParamsHandling: 'merge' });
  }

  protected async closeRow(): Promise<void> {
    const opener = this.opener;
    this.opener = null;
    await this.router?.navigate([], { relativeTo: this.route, queryParams: { row: null }, queryParamsHandling: 'merge' });
    afterNextRender(
      () => {
        const target = opener?.isConnected ? opener : this.host.nativeElement.querySelector<HTMLElement>('[role="grid"] [tabindex="0"], .card');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  /** Esc outside the peek (on the table or board) closes it too, unless something there used the key. */
  protected escape(event: Event): void {
    if (!this.openRowId() || event.defaultPrevented || this.adding()) return;
    if ((event.target as HTMLElement | null)?.closest?.('app-row-peek')) return; // the peek decides
    void this.closeRow();
  }

  protected load(): void {
    void this.store.load(this.pageId(), this.workspaceId());
  }

  /** Arrow keys move between view tabs (and show that view), as tabs do. */
  protected tabKeydown(event: KeyboardEvent, index: number): void {
    const views = this.store.database()?.views ?? [];
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : index + step;
    if ((step === 0 && event.key !== 'Home' && event.key !== 'End') || !views[target]) return;
    event.preventDefault();
    void this.store.selectView(views[target].id);
    afterNextRender(() => this.host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus(), {
      injector: this.injector,
    });
  }

  protected async addView(layout: 'table' | 'board'): Promise<void> {
    this.adding.set(false);
    const view = await this.store.addView(layout);
    if (!view) return;
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(), {
      injector: this.injector,
    });
  }

  protected menuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.adding.set(false);
      this.host.nativeElement.querySelector<HTMLElement>('.add-view')?.focus();
    }
  }

  protected closeMenuOutside(event: MouseEvent): void {
    if (this.adding() && !(event.target as HTMLElement | null)?.closest('.add-view-wrap')) this.adding.set(false);
  }
}
