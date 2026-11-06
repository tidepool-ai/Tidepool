import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
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
  signal,
  untracked,
} from '@angular/core';
import { Property, PropertyOption, Row } from '../database.api';
import { BOARD_LIMIT, DatabaseStore } from '../database.store';

/** Column id for rows with no value. */
export const NO_VALUE = '';

export interface BoardColumn {
  id: string;
  name: string;
  option: PropertyOption | null;
  rows: Row[];
}

interface Lifted {
  rowId: string;
  /** Column the card started in, and the one it's over now. */
  from: string;
  to: string;
}

/**
 * Board lens (FR-15, T18): a column per option of the view's Status or Select property, plus one for
 * rows without a value. Drag a card to another column, or with the keyboard: Space picks it up,
 * Left / Right choose the column, Space drops it, Escape puts it back. Either way the row's property
 * changes.
 */
@Component({
  selector: 'app-database-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag],
  templateUrl: './board.html',
  styleUrl: './board.scss',
})
export class DatabaseBoard {
  protected readonly store = inject(DatabaseStore);
  readonly readOnly = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly limit = BOARD_LIMIT;
  protected readonly lifted = signal<Lifted | null>(null);
  /** Card whose title is being typed (a card just added). */
  protected readonly naming = signal<string | null>(null);
  protected readonly announcement = signal('');

  /** The property the board groups by. */
  protected readonly group = computed((): Property | null => {
    const id = this.store.view()?.config.group_by;
    const property = this.store.properties().find((p) => p.id === id);
    return property && (property.type === 'status' || property.type === 'select') ? property : null;
  });

  protected readonly columns = computed((): BoardColumn[] => {
    const group = this.group();
    if (!group) return [];
    const lifted = this.lifted();
    const byColumn = new Map<string, Row[]>();
    const options = group.options ?? [];
    for (const option of options) byColumn.set(option.id, []);
    byColumn.set(NO_VALUE, []);
    for (const row of this.store.rows()) {
      const value = row.properties[group.id];
      const column = lifted?.rowId === row.id ? lifted.to : typeof value === 'string' && byColumn.has(value) ? value : NO_VALUE;
      byColumn.get(column)!.push(row);
    }
    return [
      { id: NO_VALUE, name: `No ${group.name}`, option: null, rows: byColumn.get(NO_VALUE)! },
      ...options.map((option) => ({ id: option.id, name: option.name, option, rows: byColumn.get(option.id)! })),
    ];
  });

  protected readonly columnIds = computed(() => this.columns().map((c) => this.listId(c.id)));

  constructor() {
    // A board shows every card at once, so fetch the rest of the rows.
    effect(() => {
      if (this.store.status() === 'ready' && this.store.hasMore()) untracked(() => void this.store.loadAll());
    });
  }

  protected listId(columnId: string): string {
    return `board-column-${columnId || 'none'}`;
  }

  protected title(row: Row): string {
    return row.title || 'Untitled';
  }

  // Mouse --------------------------------------------------------------------------------------------

  protected dropped(event: CdkDragDrop<string, string, Row>): void {
    if (event.previousContainer === event.container) return; // order within a column isn't stored
    void this.moveTo(event.item.data, event.container.data);
  }

  // Keyboard ---------------------------------------------------------------------------------------

  protected cardKeydown(event: KeyboardEvent, row: Row, columnIndex: number, cardIndex: number): void {
    if (this.naming() === row.id) return;
    const lifted = this.lifted();
    const columns = this.columns();
    if (lifted?.rowId === row.id) {
      const at = columns.findIndex((c) => c.id === lifted.to);
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowLeft': {
          event.preventDefault();
          const next = columns[at + (event.key === 'ArrowRight' ? 1 : -1)];
          if (!next) return;
          this.lifted.set({ ...lifted, to: next.id });
          this.announcement.set(`${this.title(row)}: over ${next.name}. Space to drop, Escape to cancel.`);
          this.focusCard(row.id);
          return;
        }
        case ' ':
        case 'Enter': {
          event.preventDefault();
          this.lifted.set(null);
          const target = columns.find((c) => c.id === lifted.to)!;
          if (lifted.to === lifted.from) {
            this.announcement.set(`${this.title(row)} stays in ${target.name}.`);
          } else {
            void this.moveTo(row, lifted.to);
          }
          this.focusCard(row.id);
          return;
        }
        case 'Escape':
        case 'Tab': {
          if (event.key === 'Escape') event.preventDefault();
          this.lifted.set(null);
          const home = columns.find((c) => c.id === lifted.from)!;
          this.announcement.set(`${this.title(row)} put back in ${home.name}.`);
          this.focusCard(row.id);
          return;
        }
      }
      return;
    }
    switch (event.key) {
      case ' ':
        if (this.readOnly()) return;
        event.preventDefault();
        {
          const column = columns[columnIndex];
          this.lifted.set({ rowId: row.id, from: column.id, to: column.id });
          this.announcement.set(
            `Picked up ${this.title(row)} in ${column.name}. Left and right arrows choose a column, Space drops, Escape cancels.`,
          );
        }
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const cards = columns[columnIndex].rows;
        const next = cards[cardIndex + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) this.focusCard(next.id);
        return;
      }
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        for (let c = columnIndex + step; c >= 0 && c < columns.length; c += step) {
          const cards = columns[c].rows;
          if (cards.length) {
            this.focusCard(cards[Math.min(cardIndex, cards.length - 1)].id);
            return;
          }
        }
        return;
      }
    }
  }

  private async moveTo(row: Row, columnId: string): Promise<void> {
    const group = this.group();
    if (!group || this.readOnly()) return;
    const current = row.properties[group.id] ?? NO_VALUE;
    if (current === columnId) return;
    const column = this.columns().find((c) => c.id === columnId);
    this.announcement.set(`Moved ${this.title(row)} to ${column?.name ?? 'another column'}.`);
    await this.store.updateCell(row.id, group, columnId === NO_VALUE ? null : columnId);
  }

  private focusCard(rowId: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-card="${rowId}"]`)?.focus(), {
      injector: this.injector,
    });
  }

  // Adding cards ----------------------------------------------------------------------------------

  protected async addCard(column: BoardColumn): Promise<void> {
    const group = this.group();
    if (!group) return;
    const row = await this.store.addRow(column.id === NO_VALUE ? {} : { [group.id]: column.id });
    if (!row) return;
    this.naming.set(row.id);
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLInputElement>(`[data-card="${row.id}"] input`)?.focus(),
      { injector: this.injector },
    );
  }

  protected async nameCard(row: Row, title: string, keepFocus = true): Promise<void> {
    if (this.naming() !== row.id) return;
    this.naming.set(null);
    if (title !== row.title) await this.store.updateCell(row.id, this.store.properties().find((p) => p.type === 'title')!, title);
    if (keepFocus) this.focusCard(row.id);
  }

  protected cancelNaming(row: Row): void {
    this.naming.set(null);
    this.focusCard(row.id);
  }

  protected setGroup(id: string): void {
    void this.store.updateViewConfig({ group_by: id });
  }
}
