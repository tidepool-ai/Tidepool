import { Property, PropertyType } from '../database.api';
import { formatDay, formatNumber, optionsOf } from '../format';

/** One filter condition, as the API takes it (docs/DATABASES.md). `value` is missing until chosen. */
export interface Condition {
  property: string;
  operator: string;
  value?: unknown;
}

/** A view's filter as the toolbar edits it: conditions joined by "and" or "or". */
export interface FilterModel {
  mode: 'and' | 'or';
  conditions: Condition[];
  /** Saved with nested groups (through the API): shown, but only cleared, not edited, here. */
  advanced: boolean;
}

export interface Sort {
  property: string;
  direction: 'ascending' | 'descending';
}

/** The API's limit on sorts per query. */
export const MAX_SORTS = 5;

const TEXTUAL = ['is', 'is_not', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'];
const NUMERIC = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
  'is_empty',
  'is_not_empty',
];
const CHOICE = ['is', 'is_not', 'is_empty', 'is_not_empty'];
const LISTS = ['contains', 'does_not_contain', 'is_empty', 'is_not_empty'];
const DATES = ['is', 'before', 'after', 'on_or_before', 'on_or_after', 'is_empty', 'is_not_empty'];

const OPERATORS: Record<PropertyType, string[]> = {
  title: TEXTUAL,
  text: TEXTUAL,
  url: TEXTUAL,
  number: NUMERIC,
  select: CHOICE,
  status: CHOICE,
  multi_select: LISTS,
  person: LISTS,
  date: DATES,
  checkbox: ['is'],
};

const LABELS: Record<string, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  does_not_contain: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  equals: 'equals',
  not_equals: 'does not equal',
  greater_than: 'is greater than',
  less_than: 'is less than',
  greater_than_or_equal: 'is at least',
  less_than_or_equal: 'is at most',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
};

export function operatorsFor(type: PropertyType): string[] {
  return OPERATORS[type] ?? [];
}

export function operatorLabel(operator: string, type?: PropertyType): string {
  if (type === 'multi_select' || type === 'person') {
    if (operator === 'contains') return 'includes';
    if (operator === 'does_not_contain') return 'does not include';
  }
  return LABELS[operator] ?? operator;
}

export function needsValue(operator: string): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

/** A new condition for a property: text "contains", checkboxes "is checked"; most wait for a value. */
export function newCondition(property: Property): Condition {
  const textual = property.type === 'title' || property.type === 'text' || property.type === 'url';
  const operator = textual ? 'contains' : operatorsFor(property.type)[0];
  return property.type === 'checkbox' ? { property: property.id, operator, value: true } : { property: property.id, operator };
}

/** Whether the API would take it: a value when the operator needs one, none otherwise. */
export function isComplete(condition: Condition): boolean {
  if (!needsValue(condition.operator)) return true;
  const value = condition.value;
  return value !== undefined && value !== null && value !== '' && !(typeof value === 'number' && Number.isNaN(value));
}

/** The condition as sent: no `value` key for "is empty" and "is not empty". */
export function cleanCondition(condition: Condition): Condition {
  const { property, operator, value } = condition;
  return needsValue(operator) ? { property, operator, value } : { property, operator };
}

function isCondition(raw: unknown): raw is Condition {
  return !!raw && typeof raw === 'object' && 'property' in raw && 'operator' in raw;
}

/** Read a saved filter. Anything nested deeper than one group is kept as "advanced". */
export function parseFilter(raw: unknown): FilterModel {
  if (raw === null || raw === undefined) return { mode: 'and', conditions: [], advanced: false };
  if (isCondition(raw)) return { mode: 'and', conditions: [raw], advanced: false };
  if (typeof raw === 'object') {
    const group = raw as { and?: unknown; or?: unknown };
    const mode = Array.isArray(group.or) ? 'or' : 'and';
    const items = group[mode];
    if (Array.isArray(items) && items.every(isCondition)) return { mode, conditions: items, advanced: false };
  }
  return { mode: 'and', conditions: [], advanced: true };
}

/** The filter to save: null when there are no conditions. */
export function toFilter(mode: 'and' | 'or', conditions: Condition[]): unknown {
  return conditions.length ? { [mode]: conditions.map(cleanCondition) } : null;
}

/** The value in words, as on its chip ("Done", "Nov 5, 2026", "ada@example.com"). */
export function valueText(condition: Condition, property: Property, people: Map<string, string>): string {
  const value = condition.value;
  if (value === undefined || value === null || value === '') return '';
  switch (property.type) {
    case 'select':
    case 'status':
    case 'multi_select':
      return optionsOf(property, value as string)[0]?.name ?? 'Unknown option';
    case 'person':
      return people.get(String(value)) ?? 'Unknown person';
    case 'date':
      return formatDay(String(value));
    case 'number':
      return typeof value === 'number' ? formatNumber(value, property.number_format) : String(value);
    case 'checkbox':
      return value ? 'checked' : 'not checked';
    default:
      return `“${String(value)}”`;
  }
}

/** "Status is not Done", "Due is before Nov 5, 2026", "Tags is empty". */
export function conditionText(condition: Condition, property: Property | undefined, people: Map<string, string>): string {
  if (!property) return 'Unknown property';
  if (property.type === 'checkbox') return `${property.name} is ${condition.value ? 'checked' : 'not checked'}`;
  const operator = operatorLabel(condition.operator, property.type);
  const value = needsValue(condition.operator) ? valueText(condition, property, people) : '';
  return [property.name, operator, value].filter(Boolean).join(' ');
}
