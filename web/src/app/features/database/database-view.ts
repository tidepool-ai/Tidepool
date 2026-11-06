import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, effect, inject, input, signal, untracked } from '@angular/core';
import { DatabaseBoard } from './board/board';
import { DatabaseStore } from './database.store';
import { DatabaseTable } from './table/table';

/** A database page's body: its views as tabs, and the active one (Table, T17, or Board, T18). */
@Component({
  selector: 'app-database-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatabaseTable, DatabaseBoard],
  providers: [DatabaseStore],
  templateUrl: './database-view.html',
  styleUrl: './database-view.scss',
  host: { '(document:mousedown)': 'closeMenuOutside($event)' },
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
