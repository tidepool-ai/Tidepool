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
} from '@angular/core';
import { Property, PropertyType, typeLabel } from '../database.api';
import { DatabaseStore } from '../database.store';
import {
  Condition,
  MAX_SORTS,
  Sort,
  conditionText,
  isComplete,
  needsValue,
  newCondition,
  operatorLabel,
  operatorsFor,
  parseFilter,
  toFilter,
} from './filter';

type Open = { kind: 'add' } | { kind: 'filter'; index: number } | { kind: 'sort' };

/** A view's filter chips and sort menu (T20). Changes are saved to the view at once. */
@Component({
  selector: 'app-view-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './view-toolbar.html',
  styleUrl: './view-toolbar.scss',
  host: { '(document:mousedown)': 'closeOutside($event)' },
})
export class ViewToolbar {
  protected readonly store = inject(DatabaseStore);
  readonly readOnly = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly MAX_SORTS = MAX_SORTS;
  protected readonly operatorLabel = operatorLabel;
  protected readonly operatorsFor = operatorsFor;
  protected readonly needsValue = needsValue;
  protected readonly typeLabel = typeLabel;

  protected readonly open = signal<Open | null>(null);
  /** The condition in the open filter editor (a new one isn't saved until it has a value). */
  protected readonly draft = signal<Condition | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal('');
  /** Where focus goes back to when a popover closes. */
  private opener: HTMLElement | null = null;

  protected readonly filter = computed(() => parseFilter(this.store.view()?.config.filter));
  protected readonly sorts = computed((): Sort[] => this.store.view()?.config.sorts ?? []);
  protected readonly byId = computed(() => new Map(this.store.properties().map((p) => [p.id, p])));
  protected readonly draftProperty = computed(() => {
    const draft = this.draft();
    return draft ? this.byId().get(draft.property) : undefined;
  });
  protected readonly sortLabel = computed(() => {
    const sorts = this.sorts();
    if (sorts.length === 0) return 'Sort';
    if (sorts.length > 1) return `${sorts.length} sorts`;
    return `Sorted by ${this.byId().get(sorts[0].property)?.name ?? 'a property'}`;
  });
  /** Properties no sort uses yet, for "Add a sort". */
  protected readonly unsorted = computed(() => {
    const used = new Set(this.sorts().map((s) => s.property));
    return this.store.properties().filter((p) => !used.has(p.id));
  });
  protected readonly visible = computed(
    () => !this.readOnly() || this.filter().conditions.length > 0 || this.filter().advanced || this.sorts().length > 0,
  );

  /** Which control picks the value. */
  protected valueKind(type: PropertyType): 'number' | 'date' | 'checkbox' | 'person' | 'option' | 'text' {
    if (type === 'select' || type === 'status' || type === 'multi_select') return 'option';
    if (type === 'number' || type === 'date' || type === 'checkbox' || type === 'person') return type;
    return 'text';
  }

  protected chipText(condition: Condition): string {
    return conditionText(condition, this.byId().get(condition.property), this.store.memberEmails());
  }

  /** Properties another sort row doesn't use (plus its own). */
  protected sortChoices(index: number): Property[] {
    const used = new Set(this.sorts().filter((_, i) => i !== index).map((s) => s.property));
    return this.store.properties().filter((p) => !used.has(p.id));
  }

  // Popovers ---------------------------------------------------------------------------------

  protected toggle(next: Open, event: Event): void {
    const current = this.open();
    if (current && current.kind === next.kind && (current.kind !== 'filter' || current.index === (next as { index: number }).index)) {
      this.close();
      return;
    }
    this.opener = event.currentTarget as HTMLElement;
    if (next.kind === 'filter') this.draft.set({ ...this.filter().conditions[next.index] });
    this.show(next);
  }

  private show(next: Open): void {
    this.open.set(next);
    this.error.set(null);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('.popover select, .popover input, .popover button')?.focus(), {
      injector: this.injector,
    });
  }

  protected close(returnFocus = true): void {
    this.open.set(null);
    this.draft.set(null);
    const opener = this.opener;
    this.opener = null;
    if (!returnFocus) return;
    afterNextRender(
      () => {
        const target = opener?.isConnected ? opener : this.host.nativeElement.querySelector<HTMLElement>('.add-filter, .sort-button');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  protected popoverKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  /** Arrow keys move between the "Filter by" menu's items. */
  protected menuKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      this.popoverKeydown(event);
      return;
    }
    event.preventDefault();
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  protected closeOutside(event: MouseEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest?.('app-view-toolbar')) this.close(false);
  }

  // Filters ----------------------------------------------------------------------------------

  /** "+ Filter" > a property: a new condition, saved once it has a value. */
  protected async pick(property: Property): Promise<void> {
    const condition = newCondition(property);
    const index = this.filter().conditions.length;
    this.draft.set(condition);
    this.show({ kind: 'filter', index });
    if (isComplete(condition)) await this.saveDraft();
  }

  protected async setOperator(operator: string): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const keep = needsValue(operator) && needsValue(draft.operator);
    this.draft.set(keep ? { ...draft, operator } : { property: draft.property, operator });
    await this.saveDraft();
  }

  protected async setValue(value: unknown): Promise<void> {
    const draft = this.draft();
    if (!draft || draft.value === value) return;
    this.draft.set({ ...draft, value });
    await this.saveDraft();
  }

  protected numberValue(text: string): number | undefined {
    return text.trim() === '' ? undefined : Number(text);
  }

  /** Enter in a value field: save it and close. */
  protected async valueEnter(event: Event, value: unknown): Promise<void> {
    event.preventDefault();
    const save = this.setValue(value);
    if (this.draft() && isComplete(this.draft()!)) this.close();
    await save;
  }

  private async saveDraft(): Promise<void> {
    const draft = this.draft();
    const open = this.open();
    if (!draft || open?.kind !== 'filter' || !isComplete(draft)) return;
    const { mode, conditions } = this.filter();
    const isNew = open.index >= conditions.length;
    const next = isNew ? [...conditions, draft] : conditions.map((c, i) => (i === open.index ? draft : c));
    await this.save({ filter: toFilter(mode, next) }, isNew ? `Filter added: ${this.chipText(draft)}` : `Filter changed: ${this.chipText(draft)}`);
  }

  protected async removeFilter(index: number): Promise<void> {
    const { mode, conditions } = this.filter();
    const removed = conditions[index];
    if (this.open()) this.close();
    else this.focusAfterRender('.add-filter');
    if (!removed) return; // a new condition that was never saved
    await this.save({ filter: toFilter(mode, conditions.filter((_, i) => i !== index)) }, `Filter removed: ${this.chipText(removed)}`);
  }

  /** Remove the filter being edited (or drop it, if it's new). */
  protected async removeDraft(): Promise<void> {
    const open = this.open();
    if (open?.kind === 'filter') await this.removeFilter(open.index);
  }

  protected async setMode(mode: 'and' | 'or'): Promise<void> {
    const { conditions } = this.filter();
    await this.save({ filter: toFilter(mode, conditions) }, mode === 'and' ? 'Rows match all filters' : 'Rows match any filter');
  }

  protected async clearFilter(): Promise<void> {
    this.focusAfterRender('.add-filter');
    await this.save({ filter: null }, 'Filters cleared');
  }

  // Sorts ------------------------------------------------------------------------------------

  protected async addSort(): Promise<void> {
    const property = this.unsorted()[0];
    if (!property || this.sorts().length >= MAX_SORTS) return;
    await this.saveSorts([...this.sorts(), { property: property.id, direction: 'ascending' }], `Sorted by ${property.name}`);
    afterNextRender(() => Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.sort-row select')).at(-2)?.focus(), {
      injector: this.injector,
    });
  }

  protected async setSortProperty(index: number, property: string): Promise<void> {
    const sorts = this.sorts().map((s, i) => (i === index ? { ...s, property } : s));
    await this.saveSorts(sorts, `Sorted by ${this.byId().get(property)?.name ?? 'a property'}`);
  }

  protected async setSortDirection(index: number, direction: Sort['direction']): Promise<void> {
    const sorts = this.sorts().map((s, i) => (i === index ? { ...s, direction } : s));
    await this.saveSorts(sorts, `${this.byId().get(sorts[index].property)?.name ?? 'Sort'}: ${direction}`);
  }

  protected async removeSort(index: number): Promise<void> {
    const removed = this.sorts()[index];
    this.focusAfterRender('.add-sort');
    await this.saveSorts(
      this.sorts().filter((_, i) => i !== index),
      `No longer sorted by ${this.byId().get(removed.property)?.name ?? 'that property'}`,
    );
  }

  private saveSorts(sorts: Sort[], done: string): Promise<void> {
    return this.save({ sorts }, done);
  }

  private async save(config: { filter?: unknown; sorts?: Sort[] }, done: string): Promise<void> {
    this.error.set(null);
    const problem = await this.store.applyQuery(config, done);
    if (problem) this.error.set(problem);
    else this.announcement.set(done);
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), { injector: this.injector });
  }
}
