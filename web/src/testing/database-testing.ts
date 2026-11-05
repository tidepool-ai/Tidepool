import { Database, Property, PropertyValue, QueryResult, Row } from '../app/features/database/database.api';

export const PROPERTIES: Property[] = [
  { id: 'title', name: 'Name', type: 'title' },
  { id: 'notes', name: 'Notes', type: 'text' },
  { id: 'points', name: 'Points', type: 'number', number_format: 'number' },
  {
    id: 'priority',
    name: 'Priority',
    type: 'select',
    options: [
      { id: 'high', name: 'High', color: 'red' },
      { id: 'low', name: 'Low', color: 'default' },
    ],
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi_select',
    options: [
      { id: 'api', name: 'API', color: 'blue' },
      { id: 'web', name: 'Web', color: 'green' },
    ],
  },
  {
    id: 'state',
    name: 'Status',
    type: 'status',
    options: [
      { id: 'not-started', name: 'Not started', color: 'gray', group: 'todo' },
      { id: 'done', name: 'Done', color: 'green', group: 'done' },
    ],
  },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'done', name: 'Done', type: 'checkbox' },
  { id: 'link', name: 'Link', type: 'url' },
];

export function database(properties: Property[] = PROPERTIES, extra: Partial<Database> = {}): Database {
  return {
    id: 'db1',
    page_id: 'p1',
    title: 'Tasks',
    archived_at: null,
    properties,
    views: [{ id: 'v1', name: 'Table', layout: 'table', config: {}, position: 0 }],
    ...extra,
  };
}

export function row(id: string, title: string, properties: Record<string, PropertyValue> = {}): Row {
  return {
    id,
    database_id: 'db1',
    title,
    icon: null,
    properties,
    created_at: '2026-11-05T12:00:00Z',
    updated_at: '2026-11-05T12:00:00Z',
  };
}

export function rows(count: number, start = 0): Row[] {
  return Array.from({ length: count }, (_, i) => row(`r${start + i}`, `Row ${start + i}`, { points: start + i }));
}

export function page(results: Row[], next_cursor: string | null = null): QueryResult {
  return { results, next_cursor, has_more: next_cursor !== null };
}

export const MEMBERS = [
  { user_id: 'u-ada', email: 'ada@example.com', role: 'owner' },
  { user_id: 'u-bob', email: 'bob@example.com', role: 'member' },
];
