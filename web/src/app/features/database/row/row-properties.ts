import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Database, DateValue, Member, Property, PropertyValue, Row, typeLabel } from '../database.api';

/**
 * A database row's properties, above its page body (FR-17, T19): one labelled field per property,
 * saved as soon as it changes. Used in the side peek and when the row is open as a full page.
 */
@Component({
  selector: 'app-row-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './row-properties.html',
  styleUrl: './row-properties.scss',
})
export class RowProperties {
  private readonly http = inject(HttpClient);

  readonly databaseId = input.required<string>();
  readonly rowId = input.required<string>();
  readonly workspaceId = input.required<string>();
  readonly readOnly = input(false);
  /** Show "In <database>" (for a row open as a full page). */
  readonly showDatabaseLink = input(false);
  /** Emitted after every saved change, so a table or board can show it. */
  readonly rowChange = output<Row>();

  protected readonly database = signal<Database | null>(null);
  protected readonly row = signal<Row | null>(null);
  protected readonly members = signal<Member[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly typeLabel = typeLabel;
  protected readonly properties = computed(() => (this.database()?.properties ?? []).filter((p) => p.type !== 'title'));

  constructor() {
    effect(() => {
      const databaseId = this.databaseId();
      const rowId = this.rowId();
      const workspaceId = this.workspaceId();
      untracked(() => void this.load(databaseId, rowId, workspaceId));
    });
  }

  private async load(databaseId: string, rowId: string, workspaceId: string): Promise<void> {
    this.error.set(null);
    try {
      const [database, row, members] = await Promise.all([
        firstValueFrom(this.http.get<Database>(`/api/databases/${databaseId}`)),
        firstValueFrom(this.http.get<Row>(`/api/databases/${databaseId}/rows/${rowId}`)),
        firstValueFrom(this.http.get<Member[]>(`/api/workspaces/${workspaceId}/members`)).catch(() => [] as Member[]),
      ]);
      this.database.set(database);
      this.row.set(row);
      this.members.set(members);
    } catch {
      this.error.set("Couldn't load this row's properties.");
    }
  }

  protected fieldId(property: Property): string {
    return `row-prop-${property.id}`;
  }

  protected value(property: Property): PropertyValue {
    return this.row()?.properties[property.id] ?? null;
  }

  protected text(property: Property): string {
    const value = this.value(property);
    return value === null || typeof value === 'object' ? '' : String(value);
  }

  protected date(property: Property): string {
    const value = this.value(property) as DateValue | null;
    return value?.start ?? '';
  }

  protected selected(property: Property): string[] {
    const value = this.value(property);
    return Array.isArray(value) ? value : [];
  }

  // Saving ---------------------------------------------------------------------------------------

  protected saveText(property: Property, raw: string): void {
    const trimmed = raw.trim();
    if (property.type === 'number') {
      const number = trimmed === '' ? null : Number(trimmed);
      if (number !== null && !Number.isFinite(number)) {
        this.error.set(`${property.name}: enter a number`);
        return;
      }
      if (number !== this.value(property)) void this.save(property, number);
      return;
    }
    if (property.type === 'url' && trimmed && !/^https?:\/\//i.test(trimmed)) {
      this.error.set(`${property.name}: links start with http:// or https://`);
      return;
    }
    const value = trimmed || null;
    if (value !== this.value(property)) void this.save(property, value);
  }

  protected saveChoice(property: Property, optionId: string): void {
    void this.save(property, optionId || null);
  }

  protected toggleIn(property: Property, id: string, on: boolean): void {
    const current = this.selected(property);
    const next = on ? [...current.filter((v) => v !== id), id] : current.filter((v) => v !== id);
    void this.save(property, next.length ? next : null);
  }

  protected saveDate(property: Property, day: string): void {
    const current = this.value(property) as DateValue | null;
    if ((current?.start ?? '') === day) return;
    const value: DateValue | null = day ? { start: day, end: current?.end && current.end >= day ? current.end : null } : null;
    void this.save(property, value);
  }

  protected saveCheckbox(property: Property, checked: boolean): void {
    void this.save(property, checked);
  }

  /** Show the change at once; put the old value back if the server refuses it. */
  private async save(property: Property, value: PropertyValue): Promise<void> {
    const row = this.row();
    const database = this.database();
    if (!row || !database || this.readOnly()) return;
    const properties = { ...row.properties };
    const empty = value === null || value === false || (Array.isArray(value) && !value.length);
    if (empty) delete properties[property.id];
    else properties[property.id] = value;
    this.row.set({ ...row, properties });
    this.error.set(null);
    try {
      const saved = await firstValueFrom(
        this.http.patch<Row>(`/api/databases/${database.id}/rows/${row.id}`, { properties: { [property.id]: value } }),
      );
      this.row.set(saved);
      this.rowChange.emit(saved);
    } catch (error) {
      this.row.set(row);
      const detail = error instanceof HttpErrorResponse ? error.error?.detail : null;
      this.error.set(typeof detail === 'string' ? detail : "Couldn't save the change");
    }
  }
}
