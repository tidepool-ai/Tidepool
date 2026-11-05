import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DateValue, PROPERTY_TYPES, Property, PropertyType, PropertyValue, Row, typeLabel } from '../database.api';
import { DatabaseStore } from '../database.store';
import { cellText, formatDate, formatNumber, optionsOf, valueOf } from '../format';

/** Row height in px: fixed, so the virtual scroll can place any row without measuring. */
export const ROW_HEIGHT = 36;
/** Most rows' worth of height the table takes before it scrolls. */
export const MAX_VISIBLE_ROWS = 16;
const TITLE_WIDTH = 280;
const COLUMN_WIDTH = 180;
const TEXT_LIKE = new Set<PropertyType>(['title', 'text', 'url', 'number']);

interface Cell {
  row: number;
  col: number;
}

/**
 * Table lens (FR-14, T17): rows as lines, properties as columns. Only the rows in view are in the
 * page (CDK virtual scroll), so 10,000 rows scroll as smoothly as 10. Works as an ARIA grid: arrows
 * move between cells, Enter edits, Escape cancels, Delete clears.
 */
@Component({
  selector: 'app-database-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScrollingModule],
  templateUrl: './table.html',
  styleUrl: './table.scss',
  host: { '(document:mousedown)': 'closePanelsOutside($event)' },
})
export class DatabaseTable {
  protected readonly store = inject(DatabaseStore);
  /** A database in the trash shows its rows but takes no edits. */
  readonly readOnly = input(false);
  readonly label = input('Database');

  protected readonly types = PROPERTY_TYPES;
  protected readonly typeLabel = typeLabel;
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly active = signal<Cell | null>(null);
  protected readonly editing = signal<Cell | null>(null);
  /** First keystroke that started editing (typed over the cell's value). */
  protected readonly typed = signal<string | null>(null);
  protected readonly menuFor = signal<string | null>(null);
  protected readonly retype = signal<{ id: string; type: PropertyType } | null>(null);
  protected readonly adding = signal(false);
  protected readonly cellError = signal<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  protected readonly columns = this.store.columns;
  protected readonly rows = this.store.rows;
  protected readonly widths = computed(() => {
    const configured = this.store.view()?.config.widths ?? {};
    return this.columns().map((p) => configured[p.id] ?? (p.type === 'title' ? TITLE_WIDTH : COLUMN_WIDTH));
  });
  protected readonly totalWidth = computed(() => this.widths().reduce((sum, w) => sum + w, 0) + 44);
  protected readonly viewportHeight = computed(
    () => Math.max(1, Math.min(this.rows().length, MAX_VISIBLE_ROWS)) * ROW_HEIGHT,
  );
  /** Rows the grid has, counting the header; -1 while more are still to load. */
  protected readonly rowCount = computed(() => (this.store.hasMore() ? -1 : this.rows().length + 1));

  protected readonly trackRow = (_index: number, row: Row) => row.id;

  // Display ---------------------------------------------------------------------------------------

  protected text(row: Row, property: Property): string {
    return cellText(row, property, this.store.memberEmails());
  }

  protected chips(row: Row, property: Property) {
    return optionsOf(property, valueOf(row, property));
  }

  protected checked(row: Row, property: Property): boolean {
    return valueOf(row, property) === true;
  }

  protected link(row: Row, property: Property): string | null {
    const value = valueOf(row, property);
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
  }

  protected people(row: Row, property: Property): string[] {
    const value = valueOf(row, property);
    return Array.isArray(value) ? value : [];
  }

  protected dateText(row: Row, property: Property): string {
    const value = valueOf(row, property);
    return value && typeof value === 'object' && !Array.isArray(value) ? formatDate(value as DateValue) : '';
  }

  protected numberText(row: Row, property: Property): string {
    const value = valueOf(row, property);
    return typeof value === 'number' ? formatNumber(value, property.number_format) : '';
  }

  /** The editor's starting text for text-like cells. */
  protected draft(row: Row, property: Property): string {
    const typed = this.typed();
    if (typed !== null) return typed;
    const value = valueOf(row, property);
    return value === null || value === undefined ? '' : String(value);
  }

  protected dateDraft(row: Row, property: Property): string {
    const value = valueOf(row, property);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as DateValue).start : '';
  }

  protected isActive(row: number, col: number): boolean {
    const active = this.active();
    return !!active && active.row === row && active.col === col;
  }

  protected isEditing(row: number, col: number): boolean {
    const editing = this.editing();
    return !!editing && editing.row === row && editing.col === col;
  }

  protected cellLabel(row: Row, property: Property): string {
    return `${property.name}: ${this.text(row, property) || 'empty'}`;
  }

  // Moving around -----------------------------------------------------------------------------------

  protected activate(row: number, col: number): void {
    if (this.isEditing(row, col)) return;
    this.finishEditing();
    this.active.set({ row, col });
    this.focusActive();
  }

  protected keydown(event: KeyboardEvent): void {
    if (this.editing() || this.menuFor() || this.adding()) return;
    const active = this.active();
    if (!active) return;
    const lastRow = this.rows().length - 1;
    const lastCol = this.columns().length - 1;
    const move = (row: number, col: number) => {
      event.preventDefault();
      this.active.set({ row: clamp(row, 0, lastRow), col: clamp(col, 0, lastCol) });
      this.focusActive();
    };
    const page = MAX_VISIBLE_ROWS - 1;
    switch (event.key) {
      case 'ArrowDown':
        return move(active.row + 1, active.col);
      case 'ArrowUp':
        return move(active.row - 1, active.col);
      case 'ArrowRight':
        return move(active.row, active.col + 1);
      case 'ArrowLeft':
        return move(active.row, active.col - 1);
      case 'PageDown':
        return move(active.row + page, active.col);
      case 'PageUp':
        return move(active.row - page, active.col);
      case 'Home':
        return event.ctrlKey ? move(0, 0) : move(active.row, 0);
      case 'End':
        return event.ctrlKey ? move(lastRow, lastCol) : move(active.row, lastCol);
      case 'Enter':
      case 'F2':
        event.preventDefault();
        return this.startEditing(active);
      case ' ':
        if (this.columns()[active.col]?.type === 'checkbox') {
          event.preventDefault();
          void this.toggle(active.row, active.col);
        }
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        return void this.clear(active);
    }
    // Typing over a text-like cell starts editing with that character.
    const property = this.columns()[active.col];
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && TEXT_LIKE.has(property?.type)) {
      event.preventDefault();
      this.startEditing(active, event.key);
    }
  }

  /** Keep the active cell focused, scrolling it into view first if it isn't rendered. */
  private focusActive(): void {
    const active = this.active();
    if (!active) return;
    const viewport = this.viewport();
    if (viewport) {
      const top = viewport.measureScrollOffset('top');
      const fits = Math.max(1, Math.floor(viewport.getViewportSize() / ROW_HEIGHT));
      const first = Math.ceil(top / ROW_HEIGHT);
      if (active.row < first) viewport.scrollToOffset(active.row * ROW_HEIGHT);
      else if (active.row >= first + fits) viewport.scrollToOffset((active.row - fits + 1) * ROW_HEIGHT);
    }
    afterNextRender(() => this.cellElement(active)?.focus({ preventScroll: true }), { injector: this.injector });
  }

  private cellElement(cell: Cell): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[data-cell="${cell.row}:${cell.col}"]`);
  }

  protected scrolled(firstVisible: number): void {
    if (firstVisible + MAX_VISIBLE_ROWS * 2 >= this.rows().length) void this.store.loadMore();
  }

  // Editing --------------------------------------------------------------------------------------

  protected startEditing(cell: Cell, typed: string | null = null): void {
    if (this.readOnly()) return;
    const property = this.columns()[cell.col];
    if (!property) return;
    if (property.type === 'checkbox') {
      void this.toggle(cell.row, cell.col);
      return;
    }
    this.cellError.set(null);
    this.typed.set(typed);
    this.active.set(cell);
    this.editing.set(cell);
    afterNextRender(
      () => {
        const editor = this.cellElement(cell)?.querySelector<HTMLInputElement | HTMLSelectElement>('.editor');
        editor?.focus();
        if (editor instanceof HTMLInputElement && typed !== null && editor.type === 'text') {
          editor.setSelectionRange(editor.value.length, editor.value.length);
        }
      },
      { injector: this.injector },
    );
  }

  /** Save a text-like editor's value; a value that can't be saved keeps the editor open with a message. */
  protected async commitText(row: Row, property: Property, raw: string, next: 'stay' | 'down' | 'right' = 'stay'): Promise<void> {
    let value: PropertyValue;
    if (property.type === 'number') {
      const trimmed = raw.trim();
      value = trimmed === '' ? null : Number(trimmed);
      if (typeof value === 'number' && !Number.isFinite(value)) {
        this.cellError.set(`${property.name}: enter a number`);
        return;
      }
    } else if (property.type === 'url') {
      const trimmed = raw.trim();
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        this.cellError.set(`${property.name}: links start with http:// or https://`);
        return;
      }
      value = trimmed || null;
    } else {
      value = property.type === 'title' ? raw : raw || null;
    }
    this.stopEditing(next);
    const changed = property.type === 'title' ? raw !== row.title : value !== (valueOf(row, property) ?? null);
    if (changed) await this.store.updateCell(row.id, property, value);
  }

  protected async commitDate(row: Row, property: Property, day: string): Promise<void> {
    const current = valueOf(row, property) as DateValue | null;
    const value: DateValue | null = day ? { start: day, end: current?.end && current.end >= day ? current.end : null } : null;
    this.stopEditing('stay');
    if ((current?.start ?? '') !== day) await this.store.updateCell(row.id, property, value);
  }

  protected async commitChoice(row: Row, property: Property, optionId: string): Promise<void> {
    this.stopEditing('stay');
    if ((valueOf(row, property) ?? '') !== optionId) await this.store.updateCell(row.id, property, optionId || null);
  }

  /** Multi-select and person cells: each checkbox saves at once. */
  protected async toggleIn(row: Row, property: Property, id: string, on: boolean): Promise<void> {
    const current = (valueOf(row, property) as string[] | null) ?? [];
    const next = on ? [...current.filter((v) => v !== id), id] : current.filter((v) => v !== id);
    await this.store.updateCell(row.id, property, next.length ? next : null);
  }

  protected async toggle(rowIndex: number, col: number): Promise<void> {
    if (this.readOnly()) return;
    const row = this.rows()[rowIndex];
    const property = this.columns()[col];
    if (!row || property?.type !== 'checkbox') return;
    this.active.set({ row: rowIndex, col });
    await this.store.updateCell(row.id, property, !this.checked(row, property));
  }

  private async clear(cell: Cell): Promise<void> {
    if (this.readOnly()) return;
    const row = this.rows()[cell.row];
    const property = this.columns()[cell.col];
    if (!row || !property || property.type === 'title' || valueOf(row, property) === null) return;
    await this.store.updateCell(row.id, property, null);
  }

  protected editorKeydown(event: KeyboardEvent, row: Row, property: Property, editor: HTMLInputElement): void {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        void this.commitText(row, property, editor.value, 'down');
        break;
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        void this.commitText(row, property, editor.value, 'right');
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.stopEditing('stay');
        break;
    }
  }

  protected cancelEditing(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.stopEditing('stay');
  }

  /** Blur saves text, but only if this editor is still the one open (Escape/Enter already closed it). */
  protected blurText(row: Row, property: Property, editor: HTMLInputElement, rowIndex: number, col: number): void {
    if (this.isEditing(rowIndex, col)) void this.commitText(row, property, editor.value, 'stay');
  }

  private stopEditing(next: 'stay' | 'down' | 'right'): void {
    const editing = this.editing();
    this.editing.set(null);
    this.typed.set(null);
    this.cellError.set(null);
    if (!editing) return;
    const lastRow = this.rows().length - 1;
    const lastCol = this.columns().length - 1;
    const target =
      next === 'down'
        ? { row: Math.min(editing.row + 1, lastRow), col: editing.col }
        : next === 'right'
          ? { row: editing.row, col: Math.min(editing.col + 1, lastCol) }
          : editing;
    this.active.set(target);
    this.focusActive();
  }

  private finishEditing(): void {
    if (this.editing()) this.stopEditing('stay');
  }

  // Rows and properties ---------------------------------------------------------------------------

  protected async addRow(): Promise<void> {
    const row = await this.store.addRow();
    if (!row) return;
    const index = this.rows().length - 1;
    this.viewport()?.scrollToIndex(index);
    this.startEditing({ row: index, col: 0 });
  }

  protected toggleMenu(id: string): void {
    this.adding.set(false);
    this.retype.set(null);
    this.menuFor.set(this.menuFor() === id ? null : id);
    if (this.menuFor()) {
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('.panel input')?.focus(), {
        injector: this.injector,
      });
    }
  }

  private renaming: string | null = null;

  /** Save a new name (Enter also closes the menu; the blur that follows doesn't save twice). */
  protected async rename(property: Property, name: string, close = false): Promise<void> {
    const trimmed = name.trim();
    const current = this.store.properties().find((p) => p.id === property.id)?.name;
    const key = `${property.id}:${trimmed}`;
    if (close) this.closePanels(property.id);
    if (!trimmed || trimmed === current || this.renaming === key) return;
    this.renaming = key;
    try {
      await this.store.renameProperty(property.id, trimmed);
    } finally {
      this.renaming = null;
    }
  }

  protected askRetype(property: Property, type: string): void {
    if (type !== property.type) this.retype.set({ id: property.id, type: type as PropertyType });
  }

  protected async confirmRetype(): Promise<void> {
    const retype = this.retype();
    if (!retype) return;
    const saved = await this.store.retypeProperty(retype.id, retype.type);
    if (saved) this.closePanels(retype.id);
  }

  protected openAdd(): void {
    this.menuFor.set(null);
    this.adding.set(!this.adding());
    if (this.adding()) {
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('.panel input')?.focus(), {
        injector: this.injector,
      });
    }
  }

  protected async add(name: string, type: string): Promise<void> {
    const trimmed = name.trim() || `Property ${this.store.properties().length}`;
    if (await this.store.addProperty(trimmed, type as PropertyType)) this.closePanels('add');
  }

  protected panelKeydown(event: KeyboardEvent, owner: string): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closePanels(owner);
    }
  }

  /** Close the column menu / add panel and return focus to the button that opened it. */
  protected closePanels(owner: string | null = null): void {
    this.menuFor.set(null);
    this.adding.set(false);
    this.retype.set(null);
    if (owner) {
      afterNextRender(
        () => this.host.nativeElement.querySelector<HTMLElement>(`[data-header="${owner}"]`)?.focus(),
        { injector: this.injector },
      );
    }
  }

  protected closePanelsOutside(event: MouseEvent): void {
    if (!this.menuFor() && !this.adding()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.panel') || target?.closest('[data-header]')) return;
    this.closePanels();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
