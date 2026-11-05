import { DateValue, Property, PropertyOption, PropertyValue, Row } from './database.api';

const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "Nov 5, 2026" from "2026-11-05" (read as a calendar date, never shifted by time zone). */
export function formatDay(day: string): string {
  return dateFormat.format(new Date(`${day}T00:00:00Z`));
}

export function formatDate(value: DateValue): string {
  return value.end ? `${formatDay(value.start)} → ${formatDay(value.end)}` : formatDay(value.start);
}

export function formatNumber(value: number, format: Property['number_format']): string {
  switch (format) {
    case 'percent':
      return `${new Intl.NumberFormat('en').format(value)}%`;
    case 'dollar':
      return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(value);
    case 'euro':
      return new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(value);
    default:
      return new Intl.NumberFormat('en', { maximumFractionDigits: 10 }).format(value);
  }
}

export function valueOf(row: Row, property: Property): PropertyValue {
  return property.type === 'title' ? row.title : (row.properties[property.id] ?? null);
}

export function optionsOf(property: Property, value: PropertyValue): PropertyOption[] {
  const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return ids.map((id) => property.options?.find((o) => o.id === id)).filter((o): o is PropertyOption => !!o);
}

/** A cell's text, as read out by screen readers and shown for text-like types. */
export function cellText(row: Row, property: Property, people: Map<string, string>): string {
  const value = valueOf(row, property);
  if (value === null || value === undefined || value === '') return '';
  switch (property.type) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value, property.number_format) : '';
    case 'select':
    case 'status':
    case 'multi_select':
      return optionsOf(property, value)
        .map((o) => o.name)
        .join(', ');
    case 'date':
      return typeof value === 'object' && !Array.isArray(value) ? formatDate(value as DateValue) : '';
    case 'person':
      return (Array.isArray(value) ? value : []).map((id) => people.get(id) ?? 'Unknown person').join(', ');
    case 'checkbox':
      return value ? 'Checked' : 'Not checked';
    default:
      return String(value);
  }
}
