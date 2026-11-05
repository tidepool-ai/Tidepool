/** Shapes of the database API (T16, docs/DATABASES.md). */

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'person'
  | 'checkbox'
  | 'url';

export type OptionColor = 'default' | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

export interface PropertyOption {
  id: string;
  name: string;
  color: OptionColor;
  group?: 'todo' | 'in_progress' | 'done';
}

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  options?: PropertyOption[];
  number_format?: 'number' | 'percent' | 'dollar' | 'euro';
}

export interface ViewConfig {
  filter?: unknown;
  sorts?: { property: string; direction: 'ascending' | 'descending' }[];
  group_by?: string | null;
  visible_properties?: string[] | null;
  widths?: Record<string, number>;
}

export interface DatabaseViewInfo {
  id: string;
  name: string;
  layout: 'table' | 'board';
  config: ViewConfig;
  position: number;
}

export interface Database {
  id: string;
  page_id: string;
  title: string;
  archived_at: string | null;
  properties: Property[];
  views: DatabaseViewInfo[];
}

export interface DateValue {
  start: string;
  end: string | null;
}

export type PropertyValue = string | number | boolean | string[] | DateValue | null;

export interface Row {
  id: string;
  database_id: string;
  title: string;
  icon: string | null;
  properties: Record<string, PropertyValue>;
  created_at: string;
  updated_at: string;
}

export interface QueryResult {
  results: Row[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface Member {
  user_id: string;
  email: string;
}

export const PROPERTY_TYPES: readonly { type: PropertyType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Select' },
  { type: 'multi_select', label: 'Multi-select' },
  { type: 'status', label: 'Status' },
  { type: 'date', label: 'Date' },
  { type: 'person', label: 'Person' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'url', label: 'URL' },
];

export function typeLabel(type: PropertyType): string {
  return type === 'title' ? 'Title' : (PROPERTY_TYPES.find((t) => t.type === type)?.label ?? type);
}

/** The schema as sent back to PUT /schema: ids kept, so values stay with their property. */
export function schemaBody(properties: Property[]): { properties: Partial<Property>[] } {
  return {
    properties: properties.map(({ id, name, type, options, number_format }) => ({
      id,
      name,
      type,
      ...(options ? { options } : {}),
      ...(number_format ? { number_format } : {}),
    })),
  };
}
